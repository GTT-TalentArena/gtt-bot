// Sincroniza el GitHub Project de tareas con el foro 📋 tareas en los dos sentidos (cron cada 5 min).
// - Issue del Project sin post → se crea el post «#N · título».
// - Post nuevo en el foro sin número → se crea la issue, se añade al Project y se renombra el post.
// - Estado y área: se compara cada lado con lo último sincronizado para saber quién ha cambiado;
//   si cambian los dos a la vez, gana GitHub. Título, asignados y milestone van solo de GitHub a Discord.
// Discord no avisa de los cambios de etiqueta, por eso el último estado se guarda en Supabase.

import { AREA_TAGS, GUILD_ID, STATUS_TAGS } from "./config.ts"
import { api, type Env } from "./discord.ts"
import { createProjectIssue, ensureAreaField, loadProject, type ProjectItem, type ProjectMeta, setItemField } from "./proyecto.ts"
import { getPrivateText, putPrivateObject } from "./supabase.ts"
import {
  canonical,
  createPost,
  firstMention,
  forumPosts,
  githubOf,
  issueNumber,
  postTags,
  type Tag,
  tagId,
  taskContent,
  type Thread,
  threadName,
} from "./tareas.ts"

const STATE_PATH = "task-sync.json"
// Plan gratuito de Workers: 50 subpeticiones por ejecución. Lo que no quepa se hace en la siguiente pasada;
// el margen cubre los reintentos de api() ante un 429 de Discord
const BUDGET = 40
const IMPORT_COST = 5
// Una issue recién creada por /tarea crear aún no tiene post: se le da margen para que no salgan dos
const FRESH_MS = 2 * 60 * 1000

export interface Synced {
  thread: string
  status?: string
  area?: string
  title: string
  assignees: string[]
  milestone?: string
  // Primer mensaje tal como quedó en Discord: si cambia TEAM o el formato, se vuelve a escribir
  content?: string
}

export interface SyncState {
  version: 1
  // Solo se importan los posts creados después de activar la sincronización (los antiguos se ignoran)
  since: string
  items: Record<string, Synced>
}

export interface Post {
  id: string
  name: string
  status?: string
  area?: string
  archived: boolean
  applied: string[]
  ownedByBot: boolean
}

export interface Plan {
  create: boolean
  // undefined = no tocar; null = quitar la etiqueta / vaciar el campo
  discord: { status?: string | null; area?: string | null; name?: string; content?: string }
  github: { status?: string | null; area?: string | null }
  next: Omit<Synced, "thread">
}

// Fecha de creación codificada en el ID (snowflake) de Discord
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n)
}

export function toPost(t: Thread, tags: Tag[], botId: string): Post {
  return {
    id: t.id,
    name: t.name,
    ...postTags(t, tags),
    archived: Boolean(t.thread_metadata?.archived),
    applied: t.applied_tags ?? [],
    ownedByBot: t.owner_id === botId,
  }
}

/** Decide qué cambiar en cada lado para una issue del Project y su post (si lo tiene). */
export function reconcile(item: ProjectItem, post: Post | undefined, prev: Synced | undefined): Plan {
  const plan: Plan = {
    create: !post,
    discord: {},
    github: {},
    next: { status: item.status, area: item.area, title: item.title, assignees: item.assignees, milestone: item.milestone },
  }
  if (!post) return plan
  // Solo se puede saber qué lado ha cambiado si ya se sincronizó este mismo post
  const known = prev !== undefined && prev.thread === post.id

  for (const field of ["status", "area"] as const) {
    const gh = item[field]
    const dc = post[field]
    // Quitar la etiqueta de estado en Discord no vacía el Status: se vuelve a poner
    const discordChanged = known && dc !== prev[field] && !(field === "status" && dc === undefined)
    if (known && gh === prev[field] && discordChanged) {
      plan.github[field] = dc ?? null
      plan.next[field] = dc
    } else if (dc !== gh) {
      plan.discord[field] = gh ?? null
    }
  }

  if (post.name !== threadName(item)) plan.discord.name = threadName(item)
  if (post.ownedByBot) {
    const content = taskContent(item)
    plan.next.content = content
    if (!known || prev.content !== content) plan.discord.content = content
  }
  return plan
}

// Subpeticiones que gastará aplicar un plan
export function cost(plan: Plan, post: Post | undefined): number {
  if (plan.create) return 1
  const patch = plan.discord.status !== undefined || plan.discord.area !== undefined || plan.discord.name !== undefined
  return (patch ? 1 + (post?.archived ? 1 : 0) : 0) + (plan.discord.content ? 1 : 0) + Object.keys(plan.github).length
}

// Sustituye las etiquetas de estado y/o área de un post conservando las demás
export function retag(applied: string[], tags: Tag[], change: Plan["discord"]): string[] {
  let out = applied
  for (const [field, list] of [["status", STATUS_TAGS], ["area", AREA_TAGS]] as const) {
    const value = change[field]
    if (value === undefined) continue
    const ids = new Set(tags.filter((t) => canonical(t.name, list)).map((t) => t.id))
    out = out.filter((id) => !ids.has(id))
    if (value !== null) out = [...out, tagId(tags, value)]
  }
  return out
}

async function apply(env: Env, meta: ProjectMeta, tags: Tag[], item: ProjectItem, post: Post | undefined, plan: Plan): Promise<{ thread: string; contentOk: boolean }> {
  if (!post) return { thread: (await createPost(env, tags, item)).id, contentOk: true }

  const { status, area, name, content } = plan.discord
  if (status !== undefined || area !== undefined || name !== undefined) {
    // Un post archivado solo admite desarchivarlo: primero se reabre y luego se cambia
    if (post.archived) await api(env, "PATCH", `/channels/${post.id}`, { archived: false })
    const patch: Record<string, unknown> = {}
    if (name !== undefined) patch.name = name
    if (status !== undefined || area !== undefined) patch.applied_tags = retag(post.applied, tags, plan.discord)
    // Las tareas que pasan a Hecho (o que ya estaban archivadas y siguen hechas) se archivan
    if (plan.next.status === "Hecho" && (post.archived || status === "Hecho")) patch.archived = true
    await api(env, "PATCH", `/channels/${post.id}`, patch)
  }
  let contentOk = true
  if (content) {
    try {
      await api(env, "PATCH", `/channels/${post.id}/messages/${post.id}`, { content, allowed_mentions: { parse: [] } })
    } catch (err) {
      console.error(err) // el resto del post ya está sincronizado; el mensaje se reintenta en la siguiente pasada
      contentOk = false
    }
  }
  if (plan.github.status !== undefined) await setItemField(env, meta, item.itemId, "status", plan.github.status ?? undefined)
  if (plan.github.area !== undefined) await setItemField(env, meta, item.itemId, "area", plan.github.area ?? undefined)
  return { thread: post.id, contentOk }
}

// Post creado a mano en el foro → issue en el Project, y el post se renombra a «#N · título».
// En cuanto existe la issue se apunta (onCreated): aunque falle lo que sigue, el post no se vuelve a importar.
// Status y Área no se fijan aquí: se guardan vacíos, así que la siguiente pasada ve las etiquetas
// del post como un cambio de Discord y las sube al Project.
async function importPost(env: Env, meta: ProjectMeta, tags: Tag[], t: Thread, post: Post, onCreated: (number: number, synced: Synced) => void): Promise<void> {
  const msg = await api<{ content: string }>(env, "GET", `/channels/${t.id}/messages/${t.id}`)
  const owner = firstMention(msg.content) ?? t.owner_id
  const login = owner ? githubOf(owner) : undefined
  const body = [msg.content.trim(), `_Creada desde Discord: https://discord.com/channels/${GUILD_ID}/${t.id}_`].filter(Boolean).join("\n\n")
  const item = await createProjectIssue(env, meta, { title: t.name, body, assignees: login ? [login] : [] })
  onCreated(item.number, { thread: t.id, title: item.title, assignees: item.assignees })
  await api(env, "PATCH", `/channels/${t.id}`, {
    name: threadName(item),
    ...(post.status ? {} : { applied_tags: retag(post.applied, tags, { status: "To do" }) }),
  })
  await api(env, "POST", `/channels/${t.id}/messages`, {
    content: `🔗 Enlazada con la issue [#${item.number}](<${item.url}>) del Project de GitHub.${login ? "" : " ⚠️ Sin asignar: su autor no está en `TEAM`."}`,
    allowed_mentions: { parse: [] },
  })
}

function parseState(stored: string | undefined, now: Date): SyncState {
  try {
    const state = stored ? (JSON.parse(stored) as SyncState) : undefined
    if (state?.version === 1 && state.since && state.items) return state
  } catch (err) {
    console.error("[tareas] estado ilegible, se empieza de cero:", err)
  }
  return { version: 1, since: now.toISOString(), items: {} }
}

export interface SyncResult {
  created: number
  imported: number
  updated: number
  pending: number
}

export async function syncTasks(env: Env, now = new Date()): Promise<SyncResult> {
  const [project, forum, stored] = await Promise.all([loadProject(env), forumPosts(env), getPrivateText(env, STATE_PATH)])
  let used = 6 // GraphQL + etiquetas + hilos activos + archivados + leer y guardar el estado
  const meta = await ensureAreaField(env, project.meta)
  if (meta !== project.meta) used++
  const state = parseState(stored, now)
  const result: SyncResult = { created: 0, imported: 0, updated: 0, pending: 0 }

  const posts = forum.threads.map((t) => toPost(t, forum.tags, env.DISCORD_APPLICATION_ID))
  const byId = new Map(posts.map((p) => [p.id, p]))
  const byNumber = new Map<number, Post>()
  for (const p of posts) {
    const n = issueNumber(p.name)
    if (n !== undefined) byNumber.set(n, p)
  }

  // 1. Posts nuevos del foro sin issue
  const linked = new Set(Object.values(state.items).map((s) => s.thread))
  const since = Date.parse(state.since)
  for (const t of forum.threads) {
    const post = byId.get(t.id)!
    if (issueNumber(t.name) !== undefined || linked.has(t.id) || post.ownedByBot || snowflakeTime(t.id) < since) continue
    if (used + IMPORT_COST > BUDGET) {
      result.pending++
      continue
    }
    used += IMPORT_COST
    try {
      await importPost(env, meta, forum.tags, t, post, (number, synced) => {
        state.items[number] = synced
        result.imported++
      })
    } catch (err) {
      console.error(`[tareas] no se pudo importar el post ${t.id}:`, err)
    }
  }

  // 2. Issues del Project
  // (las recién importadas no están en el Project leído al principio: entran en la siguiente pasada)
  for (const item of [...project.items].sort((a, b) => a.number - b.number)) {
    const prev = state.items[item.number]
    const post = (prev && byId.get(prev.thread)) ?? byNumber.get(item.number)
    const plan = reconcile(item, post, prev)
    // Sin post visible no siempre hay que crearlo: puede estar entre los archivados que no se han
    // leído (más de 100) o lo está creando /tarea crear en este momento
    const hidden = plan.create && prev !== undefined && forum.hasMore
    const fresh = plan.create && item.createdAt !== undefined && now.getTime() - Date.parse(item.createdAt) < FRESH_MS
    if (hidden || fresh) {
      if (hidden) console.warn(`[tareas] #${item.number}: su post no está entre los archivados leídos; no se duplica`)
      result.pending++
      continue
    }
    const c = cost(plan, post)
    if (c === 0) {
      state.items[item.number] = { ...plan.next, thread: post!.id }
      continue
    }
    if (used + c > BUDGET) {
      result.pending++
      continue
    }
    used += c
    try {
      const { thread, contentOk } = await apply(env, meta, forum.tags, item, post, plan)
      // Si no se pudo editar el mensaje, se guarda el de antes para reintentarlo
      state.items[item.number] = { ...plan.next, ...(contentOk ? {} : { content: prev?.content }), thread }
      if (plan.create) result.created++
      else result.updated++
    } catch (err) {
      console.error(`[tareas] #${item.number}:`, err) // no se guarda: se reintenta en la siguiente pasada
    }
  }

  const serialized = JSON.stringify(state)
  if (serialized !== stored) await putPrivateObject(env, STATE_PATH, serialized, "application/json", true)
  return result
}
