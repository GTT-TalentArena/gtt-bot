// /resumen y el resumen diario: cuenta atrás, tareas, PRs, último deploy y log en un solo mensaje.

import { BRAND } from "./config.ts"
import { clip, type Embed, type Env, type Message } from "./discord.ts"
import { countdown, lastDeploy, logEntries, logLine, openPRs } from "./info.ts"
import { countByStatus, listTasks, taskLine } from "./tareas.ts"

// Cada bloque falla por separado: si GitHub no responde, el resto del resumen sale igual
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.error(err)
    return fallback
  }
}

export async function summary(env: Env, now = new Date()): Promise<Message> {
  const [list, prs, deploy, log] = await Promise.all([
    safe(() => listTasks(env), null),
    safe(() => openPRs(env), null),
    safe(() => lastDeploy(env), "no disponible"),
    safe(() => logEntries(env, 1), []),
  ])

  const fields: Embed["fields"] = []
  if (list) {
    const { tasks, partial } = list
    fields.push({ name: "📋 Tareas", value: countByStatus(tasks) + (partial ? "\n-# (parcial: hay más tareas archivadas)" : "") })
    const blocked = tasks.filter((t) => t.status === "Bloqueado")
    if (blocked.length) fields.push({ name: "⛔ Bloqueadas — ¡a desbloquear!", value: clip(blocked.map(taskLine)) })
    const doing = tasks.filter((t) => t.status === "En curso" || t.status === "Review")
    if (doing.length) fields.push({ name: "🚧 En marcha", value: clip(doing.map(taskLine)) })
    // owner === null: leído y sin mención; undefined: no se ha podido leer (no se marca)
    const unowned = tasks.filter((t) => t.status !== "Hecho" && t.owner === null)
    if (unowned.length) fields.push({ name: "🙋 Sin responsable", value: clip(unowned.map(taskLine)) })
  } else {
    fields.push({ name: "📋 Tareas", value: "no disponible" })
  }
  fields.push({ name: "🔀 PRs abiertas", value: prs === null ? "no disponible" : prs.length ? clip(prs) : "ninguna" })
  fields.push({ name: "🚀 Último deploy de la web", value: deploy })
  if (log.length) fields.push({ name: "📓 Última entrada del log", value: logLine(log[0]) })

  const date = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Madrid" })
  return {
    embeds: [{ title: `⚽ Resumen GTT · ${date}`, description: countdown(now), color: BRAND.estadio, fields }],
    allowed_mentions: { parse: [] }, // el resumen informa, no hace ping a nadie
  }
}
