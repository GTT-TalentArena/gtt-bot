// Archivo compartido por el Worker y el exportador local. No importa APIs de Node.
const API = "https://discord.com/api/v10"
const MESSAGEABLE_TYPES = new Set([0, 5, 10, 11, 12])
const THREAD_CONTAINER_TYPES = new Set([0, 5, 15, 16])
const PRIVATE_THREAD_CONTAINER_TYPES = new Set([0])
const CONCURRENCY = 4
const SNOWFLAKE = /^(?:[1-9][0-9]{16,19})$/
const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n

interface RateGate { retryAfter: number }
const rateGates = new WeakMap<ArchiveOptions, RateGate>()

export interface DiscordChannel { id: string; type: number; name?: string; parent_id?: string | null; position?: number; thread_metadata?: { archive_timestamp?: string } }
export interface DiscordMessage {
  id: string; channel_id: string; timestamp: string; content: string; type?: number
  author?: { username?: string; global_name?: string; bot?: boolean }
  attachments?: { filename?: string; url?: string; content_type?: string; size?: number }[]
  embeds?: { title?: string; description?: string; url?: string; provider?: { name?: string }; author?: { name?: string } }[]
}
export interface ArchiveOptions { token: string; guildId: string; fetch?: typeof fetch; warn?: (message: string) => void }
export interface ArchiveOmission {
  target: string
  operation: "channels" | "active-threads" | "archived-public-threads" | "archived-private-threads" | "joined-private-threads" | "messages"
  reason: string; channelId?: string; parentId?: string
}
export interface ArchivedChannel { channel: DiscordChannel; messages: DiscordMessage[] }
export interface ArchiveCollection { archive: ArchivedChannel[]; omissions: ArchiveOmission[] }
export interface ArchiveDiscovery { channels: DiscordChannel[]; omissions: ArchiveOmission[] }

export function isDiscordSnowflake(value: string | undefined | null): value is string {
  if (!value || !SNOWFLAKE.test(value)) return false
  try { return BigInt(value) <= MAX_SNOWFLAKE } catch { return false }
}
function requireSnowflake(value: string | undefined | null, description: string): asserts value is string {
  if (!isDiscordSnowflake(value)) throw new Error(`${description} no es un snowflake de Discord válido.`)
}
function sleep(milliseconds: number): Promise<void> { return new Promise((done) => setTimeout(done, milliseconds)) }
async function waitForRateLimit(options: ArchiveOptions): Promise<void> {
  const gate = rateGates.get(options) ?? { retryAfter: 0 }; rateGates.set(options, gate)
  while (gate.retryAfter > Date.now()) await sleep(gate.retryAfter - Date.now())
}
function query(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value))
  return search.size ? `${path}?${search}` : path
}
async function discord<T>(options: ArchiveOptions, path: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await waitForRateLimit(options)
    const response = await (options.fetch ?? fetch)(API + path, { headers: { Authorization: `Bot ${options.token}` } })
    if (response.status === 429 && attempt < 4) {
      const body = await response.json().catch(() => ({})) as { retry_after?: number }
      const seconds = Number(body.retry_after ?? 1); const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 1000
      const gate = rateGates.get(options) ?? { retryAfter: 0 }; gate.retryAfter = Math.max(gate.retryAfter, Date.now() + delay); rateGates.set(options, gate)
      options.warn?.(`Límite de Discord en ${path}; reintento en ${delay / 1000} s.`); continue
    }
    if (!response.ok) throw new Error(`Discord GET ${path} → ${response.status}: ${await response.text()}`)
    return await response.json() as T
  }
  throw new Error(`Discord GET ${path} agotó los reintentos.`)
}

export async function fetchAllMessages(options: ArchiveOptions, channelId: string): Promise<DiscordMessage[]> {
  requireSnowflake(channelId, "El ID de canal")
  const messages: DiscordMessage[] = []; let before: string | undefined; const cursors = new Set<string>()
  do {
    const page = await discord<DiscordMessage[]>(options, query(`/channels/${channelId}/messages`, { limit: 100, before }))
    for (const message of page) {
      requireSnowflake(message.id, "El ID de mensaje recibido"); requireSnowflake(message.channel_id, "El channel_id del mensaje recibido")
      if (message.channel_id !== channelId) throw new Error("Discord devolvió un mensaje de otro canal durante la paginación.")
    }
    messages.push(...page); if (page.length < 100) break
    const next = page.at(-1)?.id
    if (!next || next === before || cursors.has(next)) throw new Error("La paginación de mensajes no avanza; se omite el canal para evitar un bucle.")
    cursors.add(next); before = next
  } while (before)
  return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

/**
 * Discord devuelve los mensajes de más nuevo a más antiguo. Para actualizar un
 * canal no usamos `after`: con más de 100 mensajes ese endpoint empezaría por
 * los más nuevos y podría saltarse una página. En cambio recorremos hacia atrás
 * con `before` hasta alcanzar el último snowflake ya guardado.
 */
export async function fetchMessagesSince(options: ArchiveOptions, channelId: string, lastMessageId: string): Promise<DiscordMessage[]> {
  requireSnowflake(channelId, "El ID de canal"); requireSnowflake(lastMessageId, "El cursor de mensaje")
  const messages: DiscordMessage[] = []; let before: string | undefined; const cursors = new Set<string>(); const boundary = BigInt(lastMessageId)
  do {
    const page = await discord<DiscordMessage[]>(options, query(`/channels/${channelId}/messages`, { limit: 100, before }))
    for (const message of page) {
      requireSnowflake(message.id, "El ID de mensaje recibido"); requireSnowflake(message.channel_id, "El channel_id del mensaje recibido")
      if (message.channel_id !== channelId) throw new Error("Discord devolvió un mensaje de otro canal durante la paginación.")
      if (BigInt(message.id) > boundary) messages.push(message)
    }
    if (page.length < 100 || page.some((message) => BigInt(message.id) <= boundary)) break
    const next = page.at(-1)?.id
    if (!next || next === before || cursors.has(next)) throw new Error("La paginación incremental de mensajes no avanza; se omite el canal para evitar un bucle.")
    cursors.add(next); before = next
  } while (before)
  return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

type ArchivedThreadKind = "public" | "private" | "joined-private"
function archivedThreadPath(channelId: string, kind: ArchivedThreadKind): string { return kind === "joined-private" ? `/channels/${channelId}/users/@me/threads/archived/private` : `/channels/${channelId}/threads/archived/${kind}` }
async function fetchArchivedThreads(options: ArchiveOptions, channel: DiscordChannel, kind: ArchivedThreadKind): Promise<DiscordChannel[]> {
  requireSnowflake(channel.id, "El ID de canal")
  const threads: DiscordChannel[] = []; let before: string | undefined; const cursors = new Set<string>()
  do {
    const page = await discord<{ threads?: DiscordChannel[]; has_more?: boolean }>(options, query(archivedThreadPath(channel.id, kind), { limit: 100, before }))
    const current = page.threads ?? []; threads.push(...current); if (!page.has_more) break
    const next = kind === "joined-private" ? current.at(-1)?.id : current.at(-1)?.thread_metadata?.archive_timestamp
    if (!next) throw new Error(`No se puede continuar la paginación: falta ${kind === "joined-private" ? "id" : "archive_timestamp"}.`)
    if (kind === "joined-private") requireSnowflake(next, "El cursor de hilo privado recibido")
    if (next === before || cursors.has(next)) throw new Error("La paginación de hilos archivados no avanza; se omite el contenedor para evitar un bucle.")
    cursors.add(next); before = next
  } while (before)
  return threads
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function channelOmission(channel: DiscordChannel, operation: ArchiveOmission["operation"], reason: string): ArchiveOmission {
  return { target: `#${channel.name ?? channel.id}`, operation, reason, channelId: channel.id, ...(channel.parent_id ? { parentId: channel.parent_id } : {}) }
}
function recordOmission(options: ArchiveOptions, omissions: ArchiveOmission[], omission: ArchiveOmission): void { omissions.push(omission); options.warn?.(`Omitido ${omission.target} (${omission.operation}): ${omission.reason}`) }
function validChannels(options: ArchiveOptions, omissions: ArchiveOmission[], channels: DiscordChannel[], source: string): DiscordChannel[] {
  return channels.filter((channel) => {
    if (isDiscordSnowflake(channel.id) && (!channel.parent_id || isDiscordSnowflake(channel.parent_id))) return true
    recordOmission(options, omissions, channelOmission(channel, "channels", `Discord devolvió un ID de canal o padre no válido al enumerar ${source}.`)); return false
  })
}
async function fetchContainerThreads(options: ArchiveOptions, channel: DiscordChannel, omissions: ArchiveOmission[]): Promise<DiscordChannel[]> {
  const threads: DiscordChannel[] = []
  try { threads.push(...await fetchArchivedThreads(options, channel, "public")) } catch (error) { recordOmission(options, omissions, channelOmission(channel, "archived-public-threads", errorMessage(error))) }
  if (!PRIVATE_THREAD_CONTAINER_TYPES.has(channel.type)) return threads
  try { threads.push(...await fetchArchivedThreads(options, channel, "private")) }
  catch (error) {
    recordOmission(options, omissions, channelOmission(channel, "archived-private-threads", errorMessage(error)))
    try { threads.push(...await fetchArchivedThreads(options, channel, "joined-private")) } catch (joinedError) { recordOmission(options, omissions, channelOmission(channel, "joined-private-threads", errorMessage(joinedError))) }
  }
  return threads
}
async function mapWithConcurrency<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0
  const worker = async (): Promise<void> => { while (next < items.length) { const index = next++; results[index] = await task(items[index]) } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker)); return results
}

export async function discoverArchiveChannels(options: ArchiveOptions): Promise<ArchiveDiscovery> {
  requireSnowflake(options.guildId, "El ID de servidor"); const omissions: ArchiveOmission[] = []; let guildChannels: DiscordChannel[] = []; let active: DiscordChannel[] = []
  try { guildChannels = await discord<DiscordChannel[]>(options, `/guilds/${options.guildId}/channels`) } catch (error) { recordOmission(options, omissions, { target: "servidor", operation: "channels", reason: errorMessage(error) }) }
  try { active = (await discord<{ threads?: DiscordChannel[] }>(options, `/guilds/${options.guildId}/threads/active`)).threads ?? [] } catch (error) { recordOmission(options, omissions, { target: "servidor", operation: "active-threads", reason: errorMessage(error) }) }
  guildChannels = validChannels(options, omissions, guildChannels, "canales del servidor"); active = validChannels(options, omissions, active, "hilos activos")
  const archived = (await mapWithConcurrency(guildChannels.filter((channel) => THREAD_CONTAINER_TYPES.has(channel.type)), (channel) => fetchContainerThreads(options, channel, omissions))).flat()
  const channels = [...new Map([...guildChannels, ...active, ...validChannels(options, omissions, archived, "hilos archivados")].map((channel) => [channel.id, channel])).values()]
    .filter((channel) => MESSAGEABLE_TYPES.has(channel.type)).sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  return { channels, omissions }
}

export async function collectArchiveWithStatus(options: ArchiveOptions): Promise<ArchiveCollection> {
  const { channels, omissions } = await discoverArchiveChannels(options)
  const archive = (await mapWithConcurrency(channels, async (channel): Promise<ArchivedChannel | undefined> => {
    try { return { channel, messages: await fetchAllMessages(options, channel.id) } } catch (error) { recordOmission(options, omissions, channelOmission(channel, "messages", errorMessage(error))); return undefined }
  })).filter((item): item is ArchivedChannel => item !== undefined)
  const normal = archive.flatMap(({ messages }) => messages).filter((message) => (message.type ?? 0) === 0 && Boolean(message.author?.username ?? message.author?.global_name))
  if (normal.length && normal.every((message) => !message.content?.trim())) recordOmission(options, omissions, { target: "servidor", operation: "messages", reason: `Los ${normal.length} mensajes normales exportados no contienen texto; activa el privileged intent Message Content en Developer Portal → Bot y vuelve a exportar.` })
  return { archive, omissions }
}
export async function collectArchive(options: ArchiveOptions): Promise<ArchivedChannel[]> { return (await collectArchiveWithStatus(options)).archive }

function inline(value: string): string { return value.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/\r?\n/g, " ") }
function safeUrl(value: string | undefined): string | undefined { try { const url = new URL(value ?? ""); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined } catch { return undefined } }
function textBlock(value: string): string { const longest = Math.max(0, ...[...value.matchAll(/~+/g)].map((match) => match[0].length)); const fence = "~".repeat(Math.max(3, longest + 1)); return `${fence}text\n${value || "(sin texto)"}\n${fence}` }
function code(value: string): string { return value.replace(/`/g, "\\`") }
function messageUrl(guildId: string, channelId: string, messageId: string): string | undefined { return isDiscordSnowflake(guildId) && isDiscordSnowflake(channelId) && isDiscordSnowflake(messageId) ? `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}` : undefined }
function renderEmbed(embed: NonNullable<DiscordMessage["embeds"]>[number]): string[] {
  const lines = [`- **Embed:** ${inline(embed.title ?? embed.provider?.name ?? "sin título")}`]; const url = safeUrl(embed.url)
  if (url) lines.push(`  - URL: <${url}>`); if (embed.author?.name) lines.push(`  - Autor: ${inline(embed.author.name)}`); if (embed.description) lines.push(`  ${textBlock(embed.description).replace(/\n/g, "\n  ")}`); return lines
}
export function renderChannel(guildId: string, archived: ArchivedChannel): string {
  const { channel, messages } = archived; const lines = [`# ${inline(channel.name ?? "sin-nombre")}`, "", `- ID: \`${code(channel.id)}\``, `- Tipo: ${inline(channel.parent_id ? `thread de ${channel.parent_id}` : "canal")}`, `- Mensajes exportados: ${messages.length}`, ""]
  for (const message of messages) {
    const permalink = messageUrl(guildId, channel.id, message.id); const author = message.author?.global_name ?? message.author?.username ?? "usuario desconocido"; const bot = message.author?.bot ? " (bot)" : ""; const timestamp = inline(message.timestamp)
    lines.push(`## ${permalink ? `[${timestamp}](<${permalink}>)` : timestamp} — ${inline(author)}${bot}`, "", textBlock(message.content ?? ""), "")
    for (const embed of message.embeds ?? []) lines.push(...renderEmbed(embed), "")
    for (const attachment of message.attachments ?? []) { const url = safeUrl(attachment.url); const label = inline(attachment.filename ?? "adjunto"); const meta = [attachment.content_type && inline(attachment.content_type), attachment.size === undefined ? undefined : `${attachment.size} B`].filter(Boolean).join(", "); lines.push(url ? `- Adjunto: [${label}](<${url}>)${meta ? ` — ${meta}` : ""}` : `- Adjunto: ${label}${meta ? ` — ${meta}` : ""} (URL omitida)`, "") }
  }
  return lines.join("\n").trimEnd() + "\n"
}
export function renderIndex(guildId: string, archive: ArchivedChannel[], omissions: ArchiveOmission[] = []): string {
  const lines = ["# Archivo de Discord", "", `Servidor: \`${code(guildId)}\``, "", omissions.length ? `Estado: **parcial**; ${omissions.length} omisión(es). Consulta \`manifest.json\`.` : "Estado: completo.", "", "| Canal | ID | Mensajes | Archivo |", "| --- | --- | ---: | --- |"]
  for (const { channel, messages } of archive) lines.push(`| ${inline(channel.name ?? "sin-nombre")} | \`${code(channel.id)}\` | ${messages.length} | ${isDiscordSnowflake(channel.id) ? `[ver](channels/${channel.id}.md)` : "ID inválido: archivo omitido"} |`)
  if (omissions.length) { lines.push("", "## Omisiones"); for (const omission of omissions) lines.push(`- ${inline(omission.target)} — ${inline(omission.operation)}: ${inline(omission.reason)}`) }
  return lines.join("\n") + "\n"
}
export function archiveManifest(guildId: string, archive: ArchivedChannel[], omissions: ArchiveOmission[], generatedAt = new Date().toISOString()): string {
  return JSON.stringify({ version: 1, generatedAt, guildId, partial: omissions.length > 0, omissions, channels: archive.map(({ channel, messages }) => ({ id: channel.id, name: channel.name, type: channel.type, messages: messages.length })) }, null, 2) + "\n"
}
/** Un único Markdown para adjuntarlo desde Workers; conserva el mismo renderer seguro que el export local. */
export function renderSingleArchive(guildId: string, archive: ArchivedChannel[], omissions: ArchiveOmission[]): string {
  const index = renderIndex(guildId, archive, omissions).replace(/^# Archivo de Discord/, "# Archivo de Discord (archivo único)")
  return index + archive.map((item) => `\n---\n\n${renderChannel(guildId, item)}`).join("")
}
