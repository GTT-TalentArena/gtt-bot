/**
 * Archivo local, de solo lectura, de los canales a los que puede acceder el bot.
 *
 * Discord REST v10:
 * - GET /guilds/{guild.id}/channels
 * - GET /guilds/{guild.id}/threads/active
 * - GET /channels/{channel.id}/threads/archived/public
 * - GET /channels/{channel.id}/threads/archived/private
 * - GET /channels/{channel.id}/users/@me/threads/archived/private
 * - GET /channels/{channel.id}/messages
 *
 * Referencia: https://docs.discord.com/developers/resources/guild y
 * https://docs.discord.com/developers/resources/channel
 */
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { GUILD_ID } from "../src/config.ts"
// El Worker y este CLI comparten la representación que sale del bot. Mantenerla en
// src/ evita que una exportación privada y /archivo muestren Markdown distinto.
import { archiveManifest, renderChannel as sharedRenderChannel, renderIndex as sharedRenderIndex } from "../src/archive.ts"

const API = "https://discord.com/api/v10"
const MESSAGEABLE_TYPES = new Set([0, 5, 10, 11, 12]) // texto, anuncios y todos los threads
const THREAD_CONTAINER_TYPES = new Set([0, 5, 15, 16]) // texto, anuncios, foro y media
const PRIVATE_THREAD_CONTAINER_TYPES = new Set([0]) // Discord solo permite PRIVATE_THREAD en GUILD_TEXT
const CONCURRENCY = 4
const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CONTEXT_ROOT = resolve(BOT_ROOT, "context")
const SNOWFLAKE = /^(?:[1-9][0-9]{16,19})$/
const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n

interface RateGate {
  retryAfter: number
}

// Las peticiones de una exportación comparten una puerta de rate-limit. Sin esto,
// los workers concurrentes podrían seguir golpeando otra ruta tras un 429 global.
const rateGates = new WeakMap<ArchiveOptions, RateGate>()

export interface DiscordChannel {
  id: string
  type: number
  name?: string
  parent_id?: string | null
  position?: number
  thread_metadata?: { archive_timestamp?: string }
}

export interface DiscordMessage {
  id: string
  channel_id: string
  timestamp: string
  content: string
  type?: number
  author?: { username?: string; global_name?: string; bot?: boolean }
  attachments?: { filename?: string; url?: string; content_type?: string; size?: number }[]
  embeds?: { title?: string; description?: string; url?: string; provider?: { name?: string }; author?: { name?: string } }[]
}

export interface ArchiveOptions {
  token: string
  guildId: string
  fetch?: typeof fetch
  warn?: (message: string) => void
}

export interface ArchiveOmission {
  target: string
  operation: "channels" | "active-threads" | "archived-public-threads" | "archived-private-threads" | "joined-private-threads" | "messages"
  reason: string
  channelId?: string
  parentId?: string
}

export interface ArchiveCollection {
  archive: ArchivedChannel[]
  omissions: ArchiveOmission[]
}

export interface ArchivedChannel {
  channel: DiscordChannel
  messages: DiscordMessage[]
}

export function isDiscordSnowflake(value: string | undefined | null): value is string {
  if (!value || !SNOWFLAKE.test(value)) return false
  try {
    return BigInt(value) <= MAX_SNOWFLAKE
  } catch {
    return false
  }
}

function requireSnowflake(value: string | undefined | null, description: string): asserts value is string {
  if (!isDiscordSnowflake(value)) throw new Error(`${description} no es un snowflake de Discord válido.`)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

async function waitForRateLimit(options: ArchiveOptions): Promise<void> {
  const gate = rateGates.get(options) ?? { retryAfter: 0 }
  rateGates.set(options, gate)
  while (gate.retryAfter > Date.now()) await sleep(gate.retryAfter - Date.now())
}

function query(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value))
  const suffix = search.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function discord<T>(options: ArchiveOptions, path: string): Promise<T> {
  // La API devuelve retry_after al responder 429. Respetarlo evita perder el archivo
  // a mitad de una exportación larga por los límites de ruta de Discord.
  for (let attempt = 0; attempt < 5; attempt++) {
    await waitForRateLimit(options)
    const response = await (options.fetch ?? fetch)(API + path, {
      headers: { Authorization: `Bot ${options.token}` },
    })
    if (response.status === 429 && attempt < 4) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number }
      const retrySeconds = Number(body.retry_after ?? 1)
      const delay = Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : 1_000
      const gate = rateGates.get(options) ?? { retryAfter: 0 }
      gate.retryAfter = Math.max(gate.retryAfter, Date.now() + delay)
      rateGates.set(options, gate)
      options.warn?.(`Límite de Discord en ${path}; reintento en ${delay / 1000} s.`)
      continue
    }
    if (!response.ok) throw new Error(`Discord GET ${path} → ${response.status}: ${await response.text()}`)
    return (await response.json()) as T
  }
  throw new Error(`Discord GET ${path} agotó los reintentos.`)
}

// Discord devuelve cada página de mensajes del más reciente al más antiguo.
// `before` es el id del último elemento de la página anterior.
export async function fetchAllMessages(options: ArchiveOptions, channelId: string): Promise<DiscordMessage[]> {
  requireSnowflake(channelId, "El ID de canal")
  const pages: DiscordMessage[] = []
  let before: string | undefined
  const cursors = new Set<string>()
  do {
    const page = await discord<DiscordMessage[]>(options, query(`/channels/${channelId}/messages`, { limit: 100, before }))
    for (const message of page) {
      requireSnowflake(message.id, "El ID de mensaje recibido")
      requireSnowflake(message.channel_id, "El channel_id del mensaje recibido")
      if (message.channel_id !== channelId) throw new Error("Discord devolvió un mensaje de otro canal durante la paginación.")
    }
    pages.push(...page)
    if (page.length < 100) break
    const next = page.at(-1)?.id
    if (!next || next === before || cursors.has(next)) throw new Error("La paginación de mensajes no avanza; se omite el canal para evitar un bucle.")
    cursors.add(next)
    before = next
  } while (before)
  return pages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

type ArchivedThreadKind = "public" | "private" | "joined-private"

function archivedThreadPath(channelId: string, kind: ArchivedThreadKind): string {
  if (kind === "joined-private") return `/channels/${channelId}/users/@me/threads/archived/private`
  return `/channels/${channelId}/threads/archived/${kind}`
}

async function fetchArchivedThreads(options: ArchiveOptions, channel: DiscordChannel, kind: ArchivedThreadKind): Promise<DiscordChannel[]> {
  requireSnowflake(channel.id, "El ID de canal")
  const threads: DiscordChannel[] = []
  let before: string | undefined
  const cursors = new Set<string>()
  do {
    const page = await discord<{ threads?: DiscordChannel[]; has_more?: boolean }>(
      options,
      query(archivedThreadPath(channel.id, kind), { limit: 100, before }),
    )
    const current = page.threads ?? []
    threads.push(...current)
    // Los endpoints público/privado usan archive_timestamp; el de hilos privados
    // unidos usa el id del thread. Ambos llegan en orden descendente.
    if (!page.has_more) break
    const next = kind === "joined-private" ? current.at(-1)?.id : current.at(-1)?.thread_metadata?.archive_timestamp
    if (!next) {
      throw new Error(`No se puede continuar la paginación: falta ${kind === "joined-private" ? "id" : "archive_timestamp"}.`)
    }
    if (kind === "joined-private") requireSnowflake(next, "El cursor de hilo privado recibido")
    if (next === before || cursors.has(next)) throw new Error("La paginación de hilos archivados no avanza; se omite el contenedor para evitar un bucle.")
    cursors.add(next)
    before = next
  } while (before)
  return threads
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordOmission(options: ArchiveOptions, omissions: ArchiveOmission[], omission: ArchiveOmission): void {
  omissions.push(omission)
  options.warn?.(`Omitido ${omission.target} (${omission.operation}): ${omission.reason}`)
}

function channelOmission(channel: DiscordChannel, operation: ArchiveOmission["operation"], reason: string): ArchiveOmission {
  return {
    target: `#${channel.name ?? channel.id}`,
    operation,
    reason,
    channelId: channel.id,
    ...(channel.parent_id ? { parentId: channel.parent_id } : {}),
  }
}

function validChannels(options: ArchiveOptions, omissions: ArchiveOmission[], channels: DiscordChannel[], source: string): DiscordChannel[] {
  return channels.filter((channel) => {
    if (isDiscordSnowflake(channel.id) && (!channel.parent_id || isDiscordSnowflake(channel.parent_id))) return true
    recordOmission(options, omissions, channelOmission(channel, "channels", `Discord devolvió un ID de canal o padre no válido al enumerar ${source}.`))
    return false
  })
}

async function fetchContainerThreads(options: ArchiveOptions, channel: DiscordChannel, omissions: ArchiveOmission[]): Promise<DiscordChannel[]> {
  const threads: DiscordChannel[] = []
  try {
    threads.push(...await fetchArchivedThreads(options, channel, "public"))
  } catch (error) {
    // Un permiso por canal, o un error transitorio, no debe cancelar el resto del servidor.
    recordOmission(options, omissions, channelOmission(channel, "archived-public-threads", errorMessage(error)))
  }

  if (!PRIVATE_THREAD_CONTAINER_TYPES.has(channel.type)) return threads
  try {
    // Este endpoint enumera todos los privados visibles con MANAGE_THREADS.
    threads.push(...await fetchArchivedThreads(options, channel, "private"))
  } catch (error) {
    recordOmission(options, omissions, channelOmission(channel, "archived-private-threads", errorMessage(error)))
    try {
      // Sin MANAGE_THREADS Discord aún permite recuperar los privados que el bot haya unido.
      threads.push(...await fetchArchivedThreads(options, channel, "joined-private"))
    } catch (joinedError) {
      recordOmission(options, omissions, channelOmission(channel, "joined-private-threads", errorMessage(joinedError)))
    }
  }
  return threads
}

async function mapWithConcurrency<T, R>(items: T[], task: (item: T) => Promise<R>, concurrency = CONCURRENCY): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

function uniqueChannels(channels: DiscordChannel[]): DiscordChannel[] {
  return [...new Map(channels.map((channel) => [channel.id, channel])).values()]
}

function channelOrder(a: DiscordChannel, b: DiscordChannel): number {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
}

/** Obtiene los canales y threads que el bot puede leer, y registra omisiones no fatales. */
export async function collectArchiveWithStatus(options: ArchiveOptions): Promise<ArchiveCollection> {
  requireSnowflake(options.guildId, "El ID de servidor")
  const omissions: ArchiveOmission[] = []
  let guildChannels: DiscordChannel[] = []
  try {
    guildChannels = await discord<DiscordChannel[]>(options, `/guilds/${options.guildId}/channels`)
  } catch (error) {
    // Aun sin la lista raíz, el índice/manifiesto debe dejar constancia de que no
    // se pudo exportar el servidor en vez de parecer un archivo vacío completo.
    recordOmission(options, omissions, { target: "servidor", operation: "channels", reason: errorMessage(error) })
  }
  let active: DiscordChannel[] = []
  try {
    active = (await discord<{ threads?: DiscordChannel[] }>(options, `/guilds/${options.guildId}/threads/active`)).threads ?? []
  } catch (error) {
    recordOmission(options, omissions, { target: "servidor", operation: "active-threads", reason: errorMessage(error) })
  }
  guildChannels = validChannels(options, omissions, guildChannels, "canales del servidor")
  active = validChannels(options, omissions, active, "hilos activos")
  const containers = guildChannels.filter((channel) => THREAD_CONTAINER_TYPES.has(channel.type))
  const archived = (await mapWithConcurrency(containers, (channel) => fetchContainerThreads(options, channel, omissions))).flat()
  const channels = uniqueChannels([...guildChannels, ...active, ...validChannels(options, omissions, archived, "hilos archivados")])
    .filter((channel) => MESSAGEABLE_TYPES.has(channel.type))
    .sort(channelOrder)

  const fetched = await mapWithConcurrency(channels, async (channel): Promise<ArchivedChannel | undefined> => {
    try {
      return { channel, messages: await fetchAllMessages(options, channel.id) }
    } catch (error) {
      // El bot puede ver la lista de un canal pero no su historial por permisos individuales.
      recordOmission(options, omissions, channelOmission(channel, "messages", errorMessage(error)))
      return undefined
    }
  })
  const archive = fetched.filter((item): item is ArchivedChannel => item !== undefined)
  const normalMessages = archive.flatMap(({ messages }) => messages).filter((message) => (message.type ?? 0) === 0 && Boolean(message.author?.username ?? message.author?.global_name))
  if (normalMessages.length && normalMessages.every((message) => !message.content?.trim())) {
    recordOmission(options, omissions, {
      target: "servidor",
      operation: "messages",
      reason: `Los ${normalMessages.length} mensajes normales exportados no contienen texto; activa el privileged intent Message Content en Developer Portal → Bot y vuelve a exportar.`,
    })
  }
  return { archive, omissions }
}

/** Compatibilidad para consumidores que solo necesitan el contenido exportado. */
export async function collectArchive(options: ArchiveOptions): Promise<ArchivedChannel[]> {
  return (await collectArchiveWithStatus(options)).archive
}

function inline(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/\r?\n/g, " ")
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
  } catch {
    return undefined
  }
}

function textBlock(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/~+/g)].map((match) => match[0].length))
  const fence = "~".repeat(Math.max(3, longest + 1))
  return `${fence}text\n${value || "(sin texto)"}\n${fence}`
}

function code(value: string): string {
  return value.replace(/`/g, "\\`")
}

function messageUrl(guildId: string, channelId: string, messageId: string): string | undefined {
  if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) return undefined
  return `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`
}

function renderEmbed(embed: NonNullable<DiscordMessage["embeds"]>[number]): string[] {
  const lines = [`- **Embed:** ${inline(embed.title ?? embed.provider?.name ?? "sin título")}`]
  const url = safeUrl(embed.url)
  if (url) lines.push(`  - URL: <${url}>`)
  if (embed.author?.name) lines.push(`  - Autor: ${inline(embed.author.name)}`)
  if (embed.description) lines.push(`  ${textBlock(embed.description).replace(/\n/g, "\n  ")}`)
  return lines
}

export function renderChannel(guildId: string, archived: ArchivedChannel): string {
  const { channel, messages } = archived
  const kind = channel.parent_id ? `thread de ${channel.parent_id}` : "canal"
  const lines = [
    `# ${inline(channel.name ?? "sin-nombre")}`,
    "",
    `- ID: \`${code(channel.id)}\``,
    `- Tipo: ${inline(kind)}`,
    `- Mensajes exportados: ${messages.length}`,
    "",
  ]
  for (const message of messages) {
    const author = message.author?.global_name ?? message.author?.username ?? "usuario desconocido"
    const bot = message.author?.bot ? " (bot)" : ""
    const permalink = messageUrl(guildId, channel.id, message.id)
    const timestamp = inline(message.timestamp)
    lines.push(`## ${permalink ? `[${timestamp}](<${permalink}>)` : timestamp} — ${inline(author)}${bot}`, "", textBlock(message.content ?? ""), "")
    for (const embed of message.embeds ?? []) lines.push(...renderEmbed(embed), "")
    for (const attachment of message.attachments ?? []) {
      const url = safeUrl(attachment.url)
      const label = inline(attachment.filename ?? "adjunto")
      const metadata = [attachment.content_type && inline(attachment.content_type), attachment.size === undefined ? undefined : `${attachment.size} B`].filter(Boolean).join(", ")
      lines.push(url ? `- Adjunto: [${label}](<${url}>)${metadata ? ` — ${metadata}` : ""}` : `- Adjunto: ${label}${metadata ? ` — ${metadata}` : ""} (URL omitida)`, "")
    }
  }
  return lines.join("\n").trimEnd() + "\n"
}

export function renderIndex(guildId: string, archive: ArchivedChannel[], omissions: ArchiveOmission[] = []): string {
  const lines = ["# Archivo de Discord", "", `Servidor: \`${code(guildId)}\``, "", omissions.length ? `Estado: **parcial**; ${omissions.length} omisión(es). Consulta \`manifest.json\`.` : "Estado: completo.", "", "| Canal | ID | Mensajes | Archivo |", "| --- | --- | ---: | --- |"]
  for (const { channel, messages } of archive) {
    const file = isDiscordSnowflake(channel.id) ? `[ver](channels/${channel.id}.md)` : "ID inválido: archivo omitido"
    lines.push(`| ${inline(channel.name ?? "sin-nombre")} | \`${code(channel.id)}\` | ${messages.length} | ${file} |`)
  }
  if (omissions.length) {
    lines.push("", "## Omisiones")
    for (const omission of omissions) lines.push(`- ${inline(omission.target)} — ${inline(omission.operation)}: ${inline(omission.reason)}`)
  }
  return lines.join("\n") + "\n"
}

async function outputExists(output: string): Promise<boolean> {
  try {
    await lstat(output)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function validateArchiveIds(guildId: string, archive: ArchivedChannel[]): void {
  requireSnowflake(guildId, "El ID de servidor")
  for (const { channel, messages } of archive) {
    requireSnowflake(channel.id, "El ID de canal")
    if (channel.parent_id) requireSnowflake(channel.parent_id, "El ID padre del canal")
    for (const message of messages) {
      requireSnowflake(message.id, "El ID de mensaje")
      requireSnowflake(message.channel_id, "El channel_id del mensaje")
      if (message.channel_id !== channel.id) throw new Error("El mensaje no pertenece al canal que se va a escribir.")
    }
  }
}

async function cleanup(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Nunca ocultamos el error de exportación original por un fallo de limpieza.
  }
}

export async function writeArchive(output: string, guildId: string, archive: ArchivedChannel[], omissions: ArchiveOmission[] = []): Promise<void> {
  validateArchiveIds(guildId, archive)
  if (await outputExists(output)) throw new Error(`El destino ya existe y no se sobrescribe: ${output}`)
  const staging = resolve(dirname(output), `.${basename(output)}.tmp-${randomUUID()}`)
  const lock = resolve(dirname(output), `.${basename(output)}.lock`)
  let lockAcquired = false
  try {
    // Evita que dos exportaciones del bot publiquen sobre el mismo destino. El sistema
    // de ficheros no ofrece aquí un rename de directorio con NOREPLACE, así que la
    // segunda comprobación mitiga, pero no promete resolver, una carrera externa.
    await mkdir(lock)
    lockAcquired = true
    if (await outputExists(output)) throw new Error(`El destino ya existe y no se sobrescribe: ${output}`)
    await mkdir(resolve(staging, "channels"), { recursive: true })
    for (const item of archive) await writeFile(resolve(staging, "channels", `${item.channel.id}.md`), sharedRenderChannel(guildId, item), "utf8")
    await writeFile(resolve(staging, "index.md"), sharedRenderIndex(guildId, archive, omissions), "utf8")
    await writeFile(resolve(staging, "manifest.json"), archiveManifest(guildId, archive, omissions), "utf8")
    await rename(staging, output)
  } catch (error) {
    await cleanup(staging)
    throw error
  } finally {
    if (lockAcquired) await cleanup(lock)
  }
}

export function outputPath(argument: string | undefined): string {
  const defaultOutput = resolve(CONTEXT_ROOT, "discord")
  if (!argument) return defaultOutput
  if (isAbsolute(argument)) throw new Error("--out debe ser una ruta relativa dentro de bot/.")
  const output = resolve(BOT_ROOT, argument)
  const contextRelative = relative(CONTEXT_ROOT, output)
  if (!contextRelative || contextRelative.startsWith("..") || isAbsolute(contextRelative)) throw new Error("--out debe ser una carpeta nueva dentro de bot/context/.")
  return output
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/** Resuelve los padres reales para que --out no pueda salir de context/ mediante symlinks. */
export async function assertSafeContextOutput(output: string): Promise<void> {
  if (!isWithin(CONTEXT_ROOT, output) || output === CONTEXT_ROOT) throw new Error("--out debe ser una carpeta nueva dentro de bot/context/.")
  await mkdir(CONTEXT_ROOT, { recursive: true })
  const contextInfo = await lstat(CONTEXT_ROOT)
  if (contextInfo.isSymbolicLink()) throw new Error("bot/context no puede ser un enlace simbólico.")
  const realContext = await realpath(CONTEXT_ROOT)
  let parent = dirname(output)
  while (!(await outputExists(parent))) {
    const next = dirname(parent)
    if (next === parent) throw new Error("No se pudo resolver el padre de --out.")
    parent = next
  }
  const realParent = await realpath(parent)
  if (!isWithin(realContext, realParent)) throw new Error("--out no puede atravesar un enlace simbólico fuera de bot/context/.")
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let outputArgument: string | undefined
  let allowPartial = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--out") {
      if (outputArgument || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Uso: npm run export:discord -- [--out context/nombre-nuevo] [--allow-partial]")
      outputArgument = args[++index]
    } else if (args[index] === "--allow-partial") {
      allowPartial = true
    } else {
      throw new Error("Uso: npm run export:discord -- [--out context/nombre-nuevo] [--allow-partial]")
    }
  }
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw new Error("Falta DISCORD_BOT_TOKEN. Guárdalo en bot/.dev.vars, nunca en git.")
  const guildId = process.env.DISCORD_GUILD_ID ?? GUILD_ID
  const output = outputPath(outputArgument)
  const { archive, omissions } = await collectArchiveWithStatus({ token, guildId, warn: (message) => console.warn(`⚠ ${message}`) })
  await assertSafeContextOutput(output)
  await writeArchive(output, guildId, archive, omissions)
  console.log(`✓ ${archive.length} canales/hilos exportados a ${output}${omissions.length ? ` (parcial: ${omissions.length} omisión(es))` : ""}`)
  if (omissions.length && !allowPartial) throw new Error("El archivo es parcial; revisa index.md/manifest.json y vuelve a ejecutar con --allow-partial si aceptas esas omisiones.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
