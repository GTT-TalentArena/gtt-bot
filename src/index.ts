// Bot de Discord de GTT en Cloudflare Workers: Discord llama a este Worker por HTTP con cada comando /
// y un cron publica el resumen diario. No hay proceso encendido que mantener.

import { CHANNELS } from "./config.ts"
import { buildDiscordArchive, canDownloadArchive } from "./archivo.ts"
import { api, EPHEMERAL, editOriginal, editOriginalWithFiles, type Env, type Interaction, InteractionType, type Message, readOptions, ResponseType, verifySignature } from "./discord.ts"
import { type Experiment, postExperiment } from "./experimento.ts"
import { countdown, GitHubLimitError, logEntries, logLine, reto } from "./info.ts"
import { summary } from "./resumen.ts"
import { syncTasks } from "./sincronizar.ts"
import { createTask, listMessage, setStatus } from "./tareas.ts"

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })
const reply = (message: Message) => json({ type: ResponseType.MESSAGE, data: message })

// Discord exige respuesta en 3 s: lo que llama a otras APIs responde «pensando…» y edita después
function deferred(env: Env, ctx: ExecutionContext, i: Interaction, work: () => Promise<Message>, ephemeral = false): Response {
  ctx.waitUntil(
    work()
      .catch((err: Error): Message => {
        // El detalle (respuestas de la API) solo va a los logs, no al canal
        console.error(err)
        return { content: "⚠️ Algo ha fallado. Inténtalo de nuevo; si sigue, mira `npx wrangler tail`.", allowed_mentions: { parse: [] } }
      })
      .then((message) => editOriginal(env, i.token, message)),
  )
  return json({ type: ResponseType.DEFERRED, data: ephemeral ? { flags: EPHEMERAL } : {} })
}

function deferredArchive(env: Env, ctx: ExecutionContext, i: Interaction): Response {
  ctx.waitUntil(
    buildDiscordArchive(env, i.attachment_size_limit)
      .then((response) => editOriginalWithFiles(env, i.token, { content: response.content, allowed_mentions: { parse: [] } }, response.files))
      .catch(async (err: unknown) => {
        console.error(err)
        await editOriginal(env, i.token, { content: "⚠️ No he podido generar el archivo. Inténtalo de nuevo; si sigue, revisa `npx wrangler tail`.", allowed_mentions: { parse: [] } })
      }),
  )
  // El flag se fija al diferir: el PATCH posterior conserva la respuesta privada.
  return json({ type: ResponseType.DEFERRED, data: { flags: EPHEMERAL } })
}

// Debe coincidir con el segundo cron de wrangler.toml
export const TASK_SYNC_CRON = "*/5 * * * *"

function handle(env: Env, ctx: ExecutionContext, i: Interaction): Response {
  const user = i.member?.user.id ?? "0"
  const { sub, values: v } = readOptions(i.data?.options)
  const str = (k: string) => (v[k] === undefined ? undefined : String(v[k]))
  const num = (k: string) => (v[k] === undefined ? undefined : Number(v[k]))

  switch (i.data?.name) {
    case "countdown":
      return reply({ content: countdown() })

    case "reto":
      return reply({ embeds: [reto(str("tema") ?? "enlaces")] })

    case "log":
      return deferred(env, ctx, i, async () => {
        let description: string
        try {
          description = (await logEntries(env, 5)).map(logLine).join("\n") || "Aún no hay entradas."
        } catch (err) {
          if (!(err instanceof GitHubLimitError)) throw err
          description = `⚠️ ${err.message}. Mientras tanto: https://gtt-talentarena.github.io/log/`
        }
        return { embeds: [{ title: "📓 Log de GTT", url: "https://gtt-talentarena.github.io/log/", description }] }
      })

    case "resumen":
      return deferred(env, ctx, i, () => summary(env))

    case "experimento":
      return deferred(
        env,
        ctx,
        i,
        () =>
          postExperiment(
            env,
            {
              titulo: str("titulo")!,
              hipotesis: str("hipotesis")!,
              resultado: str("resultado")!,
              spellf1: num("spellf1"),
              macrof1: num("macrof1"),
              split: str("split"),
              enlace: str("enlace"),
              notas: str("notas"),
            } satisfies Experiment,
            user,
          ),
        true,
      )

    case "archivo":
      if (sub !== "discord") return reply({ content: "Subcomando desconocido 🤔", flags: EPHEMERAL })
      if (!canDownloadArchive(i)) return reply({ content: "🔒 `/archivo discord` solo está disponible para el rol ⚽ GTT Team dentro del servidor GTT.", flags: EPHEMERAL })
      return deferredArchive(env, ctx, i)

    case "tarea":
      if (sub === "crear") {
        return deferred(env, ctx, i, () =>
          createTask(env, { titulo: str("titulo")!, responsable: str("responsable")!, area: str("area")!, detalle: str("detalle") }, user),
        )
      }
      if (sub === "estado") {
        // Aviso inmediato y privado si se usa fuera del foro (setStatus lo vuelve a comprobar con el post real)
        if (i.channel?.parent_id !== CHANNELS.tareas) {
          return reply({ content: `Usa \`/tarea estado\` dentro del post de la tarea, en <#${CHANNELS.tareas}>.`, flags: EPHEMERAL })
        }
        return deferred(env, ctx, i, () => setStatus(env, i.channel_id ?? "", str("estado")!, user))
      }
      if (sub === "lista") {
        return deferred(env, ctx, i, () => listMessage(env, { estado: str("estado"), responsable: str("responsable") }))
      }
  }
  return reply({ content: "Comando desconocido 🤔", flags: EPHEMERAL })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("GTT bot ⚽ · Més que dades.")
    const body = await request.text()
    const ok = await verifySignature(body, request.headers.get("X-Signature-Ed25519"), request.headers.get("X-Signature-Timestamp"), env.DISCORD_PUBLIC_KEY)
    if (!ok) return new Response("firma no válida", { status: 401 })

    const interaction = JSON.parse(body) as Interaction
    if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG })
    if (interaction.type === InteractionType.COMMAND) return handle(env, ctx, interaction)
    return new Response("tipo de interacción no soportado", { status: 400 })
  },

  // Crons de wrangler.toml: resumen diario y sincronización de tareas con el GitHub Project.
  // El archivo de Discord se sincroniza desde GitHub Actions (no cabe en los límites de un Worker).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === TASK_SYNC_CRON) {
      if (!env.GITHUB_TOKEN) return console.warn("[tareas] sin GITHUB_TOKEN: no se sincroniza con GitHub")
      ctx.waitUntil(syncTasks(env).then((r) => console.log(`[tareas] +${r.created} posts · +${r.imported} issues · ${r.updated} actualizadas · ${r.pending} pendientes`)))
      return
    }
    ctx.waitUntil(summary(env).then((message) => api(env, "POST", `/channels/${CHANNELS.general}/messages`, message)))
  },
}
