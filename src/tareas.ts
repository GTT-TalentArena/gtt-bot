// /tarea: crea posts en el foro 📋 tareas, cambia su etiqueta de estado y los lista.
// Con GITHUB_TOKEN, cada post va enlazado a una issue del Project (ver src/sincronizar.ts).

import { AREA_TAGS, CHANNELS, GUILD_ID, STATUS_EMOJI, STATUS_TAGS, TEAM } from "./config.ts"
import { api, clip, type Env, type Message } from "./discord.ts"
import { createProjectIssue, ensureAreaField, loadProject, type ProjectItem, setItemField } from "./proyecto.ts"

export interface Tag {
  id: string
  name: string
}

export interface Thread {
  id: string
  name: string
  parent_id?: string
  applied_tags?: string[]
  owner_id?: string // quien creó el post
  thread_metadata?: { archived?: boolean }
}

export interface Task {
  id: string
  name: string
  status: string
  area?: string
  // id del responsable (primera mención del primer mensaje); null = no tiene; undefined = no se ha leído
  owner?: string | null
}

// Nombre canónico de una etiqueta del foro, sin distinguir mayúsculas («en Curso» → «En curso»)
export function canonical(name: string | undefined, list: readonly string[]): string | undefined {
  return name === undefined ? undefined : list.find((s) => s.toLowerCase() === name.toLowerCase())
}

// Los IDs de las etiquetas se leen del foro: así se pueden renombrar o añadir sin tocar el bot
export async function forumTags(env: Env): Promise<Tag[]> {
  const forum = await api<{ available_tags: Tag[] }>(env, "GET", `/channels/${CHANNELS.tareas}`)
  return forum.available_tags
}

export function tagId(tags: Tag[], name: string): string {
  const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
  if (!tag) throw new Error(`El foro no tiene la etiqueta «${name}»`)
  return tag.id
}

// Quita la etiqueta de estado que hubiera y pone la nueva; las de área se conservan
export function replaceStatus(applied: string[], tags: Tag[], status: string): string[] {
  const statusIds = new Set(tags.filter((t) => canonical(t.name, STATUS_TAGS)).map((t) => t.id))
  return [...applied.filter((id) => !statusIds.has(id)), tagId(tags, status)]
}

export function firstMention(content: string): string | undefined {
  return content.match(/<@!?(\d+)>/)?.[1]
}

// Los posts enlazados a una issue se titulan «#12 · Título»: así se reconocen sin guardar nada más
export function threadName(item: Pick<ProjectItem, "number" | "title">): string {
  const name = `#${item.number} · ${item.title}`
  if (name.length <= 100) return name
  // Sin partir un emoji: si no, Discord cambiaría el nombre y se renombraría en cada pasada
  const cut = name.slice(0, 99)
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + "…"
}

export function issueNumber(name: string): number | undefined {
  const n = name.match(/^#(\d+) · /)?.[1]
  return n === undefined ? undefined : Number(n)
}

export const discordOf = (login: string) => TEAM.find((t) => t.github.toLowerCase() === login.toLowerCase())?.discord || undefined
export const githubOf = (discordId: string) => TEAM.find((t) => t.discord && t.discord === discordId)?.github

// Primer mensaje de un post creado por el bot. Los asignados sin ID de Discord salen como `login`
export function taskContent(item: Pick<ProjectItem, "number" | "url" | "assignees" | "milestone">): string {
  const people = item.assignees.map((login) => {
    const id = discordOf(login)
    return id ? `<@${id}>` : `\`${login}\``
  })
  return [
    `**Responsable:** ${people.join(", ") || "*sin asignar*"}`,
    `**Issue:** [#${item.number}](${item.url})${item.milestone ? ` · **Milestone:** ${item.milestone}` : ""}`,
    "",
    "-# Sincronizada con el Project de GitHub · cambia el estado con `/tarea estado` dentro de este post",
  ].join("\n")
}

export async function createPost(env: Env, tags: Tag[], item: ProjectItem, notify: string[] = []): Promise<Thread> {
  return api<Thread>(env, "POST", `/channels/${CHANNELS.tareas}/threads`, {
    name: threadName(item),
    applied_tags: [item.status, item.area].filter((t): t is string => Boolean(t)).map((t) => tagId(tags, t)),
    // Solo se avisa a quien se indique: la sincronización no hace ping al crear posts en bloque
    message: { content: taskContent(item), allowed_mentions: { users: notify } },
  })
}

export async function createTask(
  env: Env,
  v: { titulo: string; responsable: string; area: string; detalle?: string },
  author: string,
): Promise<Message> {
  const tags = await forumTags(env)
  if (!env.GITHUB_TOKEN) {
    // Sin token no hay issue: el post queda solo en Discord
    const content = [
      `**Responsable:** <@${v.responsable}>`,
      `**Área:** ${v.area}`,
      v.detalle ? `\n${v.detalle}` : "",
      `\n-# Creada por <@${author}> · cambia el estado con \`/tarea estado\` dentro de este post`,
    ].join("\n")
    const thread = await api<Thread>(env, "POST", `/channels/${CHANNELS.tareas}/threads`, {
      name: v.titulo,
      applied_tags: [tagId(tags, "To do"), tagId(tags, v.area)],
      // Solo se avisa al responsable: un @everyone en el detalle no hace ping
      message: { content, allowed_mentions: { users: [v.responsable] } },
    })
    return { content: `📥 Tarea creada: <#${thread.id}> → <@${v.responsable}>`, allowed_mentions: { parse: [] } }
  }

  // Primero la issue (GitHub manda) y luego su post, ya enlazado
  const login = githubOf(v.responsable)
  const meta = await ensureAreaField(env, (await loadProject(env)).meta)
  const body = [v.detalle, `_Creada desde Discord con \`/tarea crear\`._`].filter(Boolean).join("\n\n")
  const item = await createProjectIssue(env, meta, { title: v.titulo, body, assignees: login ? [login] : [] })
  await Promise.all([setItemField(env, meta, item.itemId, "status", "To do"), setItemField(env, meta, item.itemId, "area", v.area)])
  const thread = await createPost(env, tags, { ...item, status: "To do", area: v.area }, [v.responsable])
  const warning = login ? "" : `\n⚠️ <@${v.responsable}> no está en \`TEAM\` (src/config.ts): la issue queda sin asignar.`
  return { content: `📥 Tarea creada: <#${thread.id}> · [#${item.number}](<${item.url}>) → <@${v.responsable}>${warning}`, allowed_mentions: { parse: [] } }
}

export async function setStatus(env: Env, threadId: string, status: string, author: string): Promise<Message> {
  const [tags, thread] = await Promise.all([forumTags(env), api<Thread>(env, "GET", `/channels/${threadId}`)])
  if (thread.parent_id !== CHANNELS.tareas) throw new Error("este canal no es un post del foro de tareas")
  await api(env, "PATCH", `/channels/${threadId}`, { applied_tags: replaceStatus(thread.applied_tags ?? [], tags, status) })
  const done = `${STATUS_EMOJI[status] ?? "🏷️"} Estado → **${status}** (por <@${author}>)`

  // Se sube a GitHub en el momento; si falla, la sincronización lo reintenta en la siguiente pasada
  const n = issueNumber(thread.name)
  if (n === undefined || !env.GITHUB_TOKEN) return { content: done, allowed_mentions: { parse: [] } }
  try {
    const { meta, items } = await loadProject(env)
    const item = items.find((i) => i.number === n)
    if (!item) return { content: `${done} · ⚠️ la issue #${n} no está en el Project de GitHub`, allowed_mentions: { parse: [] } }
    await setItemField(env, meta, item.itemId, "status", status)
    return { content: `${done} · también en GitHub`, allowed_mentions: { parse: [] } }
  } catch (err) {
    console.error(err)
    return { content: `${done} · GitHub se actualizará en la próxima sincronización`, allowed_mentions: { parse: [] } }
  }
}

// Posts del foro (activos + hasta 100 archivados) y sus etiquetas
export async function forumPosts(env: Env): Promise<{ tags: Tag[]; threads: Thread[]; hasMore: boolean }> {
  const [tags, active, archived] = await Promise.all([
    forumTags(env),
    api<{ threads: Thread[] }>(env, "GET", `/guilds/${GUILD_ID}/threads/active`),
    api<{ threads: Thread[]; has_more: boolean }>(env, "GET", `/channels/${CHANNELS.tareas}/threads/archived/public?limit=100`),
  ])
  const byId = new Map<string, Thread>()
  for (const t of [...active.threads.filter((t) => t.parent_id === CHANNELS.tareas), ...archived.threads]) byId.set(t.id, t)
  return { tags, threads: [...byId.values()], hasMore: archived.has_more }
}

// Estado y área de un post según sus etiquetas
export function postTags(t: Thread, tags: Tag[]): { status?: string; area?: string } {
  const names = (t.applied_tags ?? []).map((id) => tags.find((tag) => tag.id === id)?.name)
  return {
    status: names.map((n) => canonical(n, STATUS_TAGS)).find(Boolean),
    area: names.map((n) => canonical(n, AREA_TAGS)).find(Boolean),
  }
}

// Tareas del foro (activas + hasta 100 archivadas). Lee el responsable solo de las que no están hechas.
// Presupuesto de subpeticiones del Worker (50 en el plan gratuito): 3 + maxOwners + lo de GitHub del resumen
export async function listTasks(env: Env, maxOwners = 35): Promise<{ tasks: Task[]; partial: boolean }> {
  const { tags, threads, hasMore } = await forumPosts(env)
  const tasks: Task[] = threads.map((t) => {
    const { status, area } = postTags(t, tags)
    return { id: t.id, name: t.name, status: status ?? "Sin estado", area }
  })

  // En un foro, el ID del primer mensaje es el del propio post
  const open = tasks.filter((t) => t.status !== "Hecho").slice(0, maxOwners)
  await Promise.all(
    open.map(async (t) => {
      try {
        const msg = await api<{ content: string }>(env, "GET", `/channels/${t.id}/messages/${t.id}`)
        t.owner = firstMention(msg.content) ?? null
      } catch (err) {
        console.error(err) // queda sin leer (undefined), no «sin responsable»
      }
    }),
  )
  return { tasks, partial: hasMore || tasks.filter((t) => t.status !== "Hecho").length > maxOwners }
}

export function countByStatus(tasks: Task[]): string {
  return [...STATUS_TAGS]
    .map((s) => `${STATUS_EMOJI[s]} ${s} **${tasks.filter((t) => t.status === s).length}**`)
    .join(" · ")
}

export function taskLine(t: Task): string {
  const owner = t.owner ? ` — <@${t.owner}>` : t.owner === null ? " — *sin responsable*" : ""
  return `${STATUS_EMOJI[t.status] ?? "•"} <#${t.id}>${owner}`
}

export async function listMessage(env: Env, v: { estado?: string; responsable?: string }): Promise<Message> {
  const { tasks: all, partial } = await listTasks(env)
  let tasks = all.filter((t) => (v.estado ? t.status === v.estado : t.status !== "Hecho"))
  if (v.responsable) tasks = tasks.filter((t) => t.owner === v.responsable)
  const order = (s: string) => (STATUS_TAGS as readonly string[]).indexOf(s)
  tasks.sort((a, b) => order(a.status) - order(b.status))
  const title = v.estado ? `Tareas · ${v.estado}` : "Tareas abiertas"
  return {
    embeds: [
      {
        title: `📋 ${title} (${tasks.length})`,
        description: tasks.length ? clip(tasks.map(taskLine), 4000) : "Nada por aquí 🎉",
        footer: partial ? { text: "Lista parcial: hay más tareas de las que se pueden leer de una vez" } : undefined,
      },
    ],
    allowed_mentions: { parse: [] },
  }
}
