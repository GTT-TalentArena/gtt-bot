// /tarea: crea posts en el foro 📋 tareas, cambia su etiqueta de estado y los lista.

import { AREA_TAGS, CHANNELS, GUILD_ID, STATUS_EMOJI, STATUS_TAGS } from "./config.ts"
import { api, clip, type Env, type Message } from "./discord.ts"

interface Tag {
  id: string
  name: string
}

interface Thread {
  id: string
  name: string
  parent_id?: string
  applied_tags?: string[]
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
async function forumTags(env: Env): Promise<Tag[]> {
  const forum = await api<{ available_tags: Tag[] }>(env, "GET", `/channels/${CHANNELS.tareas}`)
  return forum.available_tags
}

function tagId(tags: Tag[], name: string): string {
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

export async function createTask(
  env: Env,
  v: { titulo: string; responsable: string; area: string; detalle?: string },
  author: string,
): Promise<Message> {
  const tags = await forumTags(env)
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

export async function setStatus(env: Env, threadId: string, status: string, author: string): Promise<Message> {
  const [tags, thread] = await Promise.all([forumTags(env), api<Thread>(env, "GET", `/channels/${threadId}`)])
  if (thread.parent_id !== CHANNELS.tareas) throw new Error("este canal no es un post del foro de tareas")
  await api(env, "PATCH", `/channels/${threadId}`, { applied_tags: replaceStatus(thread.applied_tags ?? [], tags, status) })
  return { content: `${STATUS_EMOJI[status] ?? "🏷️"} Estado → **${status}** (por <@${author}>)`, allowed_mentions: { parse: [] } }
}

// Tareas del foro (activas + hasta 100 archivadas). Lee el responsable solo de las que no están hechas.
// Presupuesto de subpeticiones del Worker (50 en el plan gratuito): 3 + maxOwners + lo de GitHub del resumen
export async function listTasks(env: Env, maxOwners = 35): Promise<{ tasks: Task[]; partial: boolean }> {
  const [tags, active, archived] = await Promise.all([
    forumTags(env),
    api<{ threads: Thread[] }>(env, "GET", `/guilds/${GUILD_ID}/threads/active`),
    api<{ threads: Thread[]; has_more: boolean }>(env, "GET", `/channels/${CHANNELS.tareas}/threads/archived/public?limit=100`),
  ])
  const byId = new Map<string, Thread>()
  for (const t of [...active.threads.filter((t) => t.parent_id === CHANNELS.tareas), ...archived.threads]) byId.set(t.id, t)

  const nameOf = (id: string) => tags.find((t) => t.id === id)?.name
  const tasks: Task[] = [...byId.values()].map((t) => {
    const names = (t.applied_tags ?? []).map(nameOf)
    return {
      id: t.id,
      name: t.name,
      status: names.map((n) => canonical(n, STATUS_TAGS)).find(Boolean) ?? "Sin estado",
      area: names.map((n) => canonical(n, AREA_TAGS)).find(Boolean),
    }
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
  return { tasks, partial: archived.has_more || tasks.filter((t) => t.status !== "Hecho").length > maxOwners }
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
