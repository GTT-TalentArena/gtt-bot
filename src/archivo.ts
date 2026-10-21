import { archiveManifest, collectArchiveWithStatus, discoverArchiveChannels, fetchAllMessages, fetchMessagesSince, renderSingleArchive, type ArchiveCollection, type ArchiveOmission, type ArchivedChannel, type DiscordMessage } from "./archive.ts"
import { ARCHIVE_ROLE_ID, GUILD_ID } from "./config.ts"
import type { Env, Interaction } from "./discord.ts"
import { getPrivateText, putPrivateObject } from "./supabase.ts"

// Discord anuncia el límite por interacción, pero no conviene intentar adjuntar
// archivos grandes aunque el servidor permita más: el formato actual es único.
export const MAX_ARCHIVE_ATTACHMENT_BYTES = 8 * 1024 * 1024
// Supabase Free admite objetos de hasta 50 MiB. Este límite protege la única
// copia almacenada antes de iniciar una escritura que Storage rechazaría.
export const MAX_ARCHIVE_STORAGE_BYTES = 50 * 1024 * 1024
// El cron está previsto cada seis horas. Pasadas doce, o tras un intento fallido,
// se entrega únicamente como última copia completa conocida y se avisa.
export const MAX_ARCHIVE_FRESHNESS_MS = 12 * 60 * 60 * 1000
const encoder = new TextEncoder()
// Un solo objeto versionado evita acumular instantáneas completas en Storage.
const LATEST_ARCHIVE_PATH = "latest-archive.json"
const ARCHIVE_HEALTH_PATH = "archive-health.json"

export interface ArchiveFile { name: string; description: string; content: string; contentType: string }
export interface ArchiveResponse { content: string; files: ArchiveFile[] }
export interface StoredArchive extends ArchiveCollection {
  version: 2
  guildId: string
  generatedAt: string
}
export interface ArchiveHealth {
  version: 1
  status: "healthy" | "failed"
  lastAttemptAt: string
  lastSuccessfulAt?: string
  latestArchiveGeneratedAt?: string
  omissions: number
  // Solo se conserva un resumen acotado para diagnosticar la Action privada;
  // no se muestra al usuario en Discord.
  failure?: string
}
export interface ArchiveSyncResult {
  created: boolean
  saved: boolean
  added: number
  archive: StoredArchive
}

/** Un rol explícito evita que el historial completo sea descargable por cualquier miembro. */
export function canDownloadArchive(interaction: Interaction): boolean {
  return interaction.guild_id === GUILD_ID && Boolean(interaction.member?.roles?.includes(ARCHIVE_ROLE_ID))
}

export function enforceArchiveSize(name: string, content: string, limit: number): void {
  const bytes = encoder.encode(content).byteLength
  if (bytes > limit) throw new Error(`El archivo ${name} ocupa ${(bytes / 1024 / 1024).toFixed(2)} MiB y supera el límite seguro de ${(limit / 1024 / 1024).toFixed(0)} MiB.`)
}

/** Serializa y comprueba el estado antes de reemplazar la copia privada. */
export function serializeArchiveForStorage(archive: StoredArchive, limit = MAX_ARCHIVE_STORAGE_BYTES): string {
  const serialized = JSON.stringify(archive)
  enforceArchiveSize(LATEST_ARCHIVE_PATH, serialized, limit)
  return serialized
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function parseStoredArchive(value: string): StoredArchive {
  const state = JSON.parse(value) as Partial<StoredArchive>
  if (state.version !== 2 || state.guildId !== GUILD_ID || !validTimestamp(state.generatedAt) || !Array.isArray(state.archive) || !Array.isArray(state.omissions)) {
    throw new Error("El archivo privado de Supabase no tiene el formato esperado; no se adjuntará.")
  }
  return state as StoredArchive
}

async function loadStoredArchive(env: Env): Promise<StoredArchive | undefined> {
  const text = await getPrivateText(env, LATEST_ARCHIVE_PATH)
  return text === undefined ? undefined : parseStoredArchive(text)
}

function parseArchiveHealth(value: string): ArchiveHealth {
  const health = JSON.parse(value) as Partial<ArchiveHealth>
  if (
    health.version !== 1 ||
    (health.status !== "healthy" && health.status !== "failed") ||
    !validTimestamp(health.lastAttemptAt) ||
    (health.lastSuccessfulAt !== undefined && !validTimestamp(health.lastSuccessfulAt)) ||
    (health.latestArchiveGeneratedAt !== undefined && !validTimestamp(health.latestArchiveGeneratedAt)) ||
    typeof health.omissions !== "number" || health.omissions < 0
  ) throw new Error("El estado de salud del archivo privado no tiene el formato esperado; no se adjuntará.")
  return health as ArchiveHealth
}

async function loadArchiveHealth(env: Env): Promise<ArchiveHealth | undefined> {
  const text = await getPrivateText(env, ARCHIVE_HEALTH_PATH)
  return text === undefined ? undefined : parseArchiveHealth(text)
}

async function saveArchiveHealth(env: Env, health: ArchiveHealth): Promise<void> {
  const serialized = JSON.stringify(health)
  enforceArchiveSize(ARCHIVE_HEALTH_PATH, serialized, MAX_ARCHIVE_STORAGE_BYTES)
  await putPrivateObject(env, ARCHIVE_HEALTH_PATH, serialized, "application/json", true)
}

function latestMessageId(messages: DiscordMessage[]): string | undefined {
  let latest: string | undefined
  for (const message of messages) if (!latest || BigInt(message.id) > BigInt(latest)) latest = message.id
  return latest
}

function sortMessages(messages: DiscordMessage[]): DiscordMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

function messageOmission(channel: ArchivedChannel["channel"], reason: string): ArchiveOmission {
  return { target: `#${channel.name ?? channel.id}`, operation: "messages", reason, channelId: channel.id, ...(channel.parent_id ? { parentId: channel.parent_id } : {}) }
}

/** Añade solo lo posterior al cursor; los mensajes ya archivados no se vuelven a pedir. */
async function updateFromPrevious(env: Env, previous: StoredArchive): Promise<{ collection: ArchiveCollection; added: number }> {
  const options = { token: env.DISCORD_BOT_TOKEN, guildId: GUILD_ID, warn: (message: string) => console.warn(`[archivo] ${message}`) }
  const discovered = await discoverArchiveChannels(options)
  const previousByChannel = new Map(previous.archive.map((item) => [item.channel.id, item]))
  const archive: ArchivedChannel[] = []; const fetched: DiscordMessage[] = []; let added = 0

  for (const channel of discovered.channels) {
    const prior = previousByChannel.get(channel.id)
    try {
      const cursor = prior && latestMessageId(prior.messages)
      const newer = cursor ? await fetchMessagesSince(options, channel.id, cursor) : await fetchAllMessages(options, channel.id)
      added += newer.length
      fetched.push(...newer)
      archive.push({ channel, messages: sortMessages([...(prior?.messages ?? []), ...newer]) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      discovered.omissions.push(messageOmission(channel, reason))
      // Una denegación temporal no borra del archivo un contexto ya capturado.
      if (prior) archive.push({ channel, messages: prior.messages })
    }
    previousByChannel.delete(channel.id)
  }

  // Conserva el histórico de canales eliminados o temporalmente inaccesibles.
  archive.push(...previousByChannel.values())
  archive.sort((a, b) => (a.channel.position ?? Number.MAX_SAFE_INTEGER) - (b.channel.position ?? Number.MAX_SAFE_INTEGER) || a.channel.id.localeCompare(b.channel.id))
  // La copia previa puede contener texto y esconder que el intent Message
  // Content se ha desactivado. Si todos los mensajes normales nuevos llegan
  // vacíos, no sustituimos el último archivo bueno por uno potencialmente roto.
  const normal = fetched.filter((message) => (message.type ?? 0) === 0 && Boolean(message.author?.username ?? message.author?.global_name))
  if (normal.length && normal.every((message) => !message.content?.trim())) {
    discovered.omissions.push({ target: "servidor", operation: "messages", reason: `Los ${normal.length} mensajes normales nuevos no contienen texto; activa el privileged intent Message Content en Developer Portal → Bot y vuelve a sincronizar.` })
  }
  return { collection: { archive, omissions: discovered.omissions }, added }
}

async function saveLatestArchive(env: Env, collection: ArchiveCollection): Promise<StoredArchive> {
  const archive: StoredArchive = { version: 2, guildId: GUILD_ID, generatedAt: new Date().toISOString(), archive: collection.archive, omissions: collection.omissions }
  // Una escritura de objeto sustituye la copia anterior completa; no hay snapshots
  // históricos ni rutas públicas que puedan crecer sin límite.
  await putPrivateObject(env, LATEST_ARCHIVE_PATH, serializeArchiveForStorage(archive), "application/json", true)
  return archive
}

function incompleteArchiveError(omissions: ArchiveOmission[]): Error {
  return new Error(`La sincronización detectó ${omissions.length} omisión(es); no se publica ni sustituye la última copia completa.`)
}

function failureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").slice(0, 500)
}

async function recordFailedSync(env: Env, previous: StoredArchive | undefined, priorHealth: ArchiveHealth | undefined, error: unknown, omissions: number): Promise<void> {
  const now = new Date().toISOString()
  const health: ArchiveHealth = {
    version: 1,
    status: "failed",
    lastAttemptAt: now,
    ...(priorHealth?.lastSuccessfulAt ? { lastSuccessfulAt: priorHealth.lastSuccessfulAt } : previous ? { lastSuccessfulAt: previous.generatedAt } : {}),
    ...(previous ? { latestArchiveGeneratedAt: previous.generatedAt } : {}),
    omissions,
    failure: failureSummary(error),
  }
  try {
    await saveArchiveHealth(env, health)
  } catch (healthError) {
    // El error principal no se convierte en éxito si tampoco se puede registrar
    // su salud. El último objeto bueno sigue intacto porque no se escribió latest.
    console.error("[archivo] No se pudo guardar el estado de salud del fallo:", healthError)
  }
}

function isSameArchive(previous: StoredArchive, collection: ArchiveCollection): boolean {
  return JSON.stringify({ archive: previous.archive, omissions: previous.omissions }) === JSON.stringify(collection)
}

/**
 * Solo la Acción programada llama a esta función: primera captura completa,
 * después sincronización incremental desde el último mensaje de cada canal.
 */
export async function syncDiscordArchive(env: Env): Promise<ArchiveSyncResult> {
  const previous = await loadStoredArchive(env)
  const priorHealth = await loadArchiveHealth(env)
  if (!previous) {
    let collection: ArchiveCollection
    try {
      collection = await collectArchiveWithStatus({ token: env.DISCORD_BOT_TOKEN, guildId: GUILD_ID, warn: (message) => console.warn(`[archivo] ${message}`) })
    } catch (error) {
      await recordFailedSync(env, undefined, priorHealth, error, 0)
      throw error
    }
    if (collection.omissions.length) {
      const error = incompleteArchiveError(collection.omissions)
      await recordFailedSync(env, undefined, priorHealth, error, collection.omissions.length)
      throw error
    }
    try {
      const archive = await saveLatestArchive(env, collection)
      await saveArchiveHealth(env, { version: 1, status: "healthy", lastAttemptAt: archive.generatedAt, lastSuccessfulAt: archive.generatedAt, latestArchiveGeneratedAt: archive.generatedAt, omissions: 0 })
      return { created: true, saved: true, added: collection.archive.reduce((total, item) => total + item.messages.length, 0), archive }
    } catch (error) {
      await recordFailedSync(env, undefined, priorHealth, error, 0)
      throw error
    }
  }
  let collection: ArchiveCollection; let added: number
  try {
    ({ collection, added } = await updateFromPrevious(env, previous))
  } catch (error) {
    await recordFailedSync(env, previous, priorHealth, error, 0)
    throw error
  }
  if (collection.omissions.length) {
    const error = incompleteArchiveError(collection.omissions)
    await recordFailedSync(env, previous, priorHealth, error, collection.omissions.length)
    throw error
  }
  try {
    const unchanged = isSameArchive(previous, collection)
    const archive = unchanged ? previous : await saveLatestArchive(env, collection)
    const now = new Date().toISOString()
    await saveArchiveHealth(env, { version: 1, status: "healthy", lastAttemptAt: now, lastSuccessfulAt: now, latestArchiveGeneratedAt: archive.generatedAt, omissions: 0 })
    return { created: false, saved: !unchanged, added, archive }
  } catch (error) {
    await recordFailedSync(env, previous, priorHealth, error, 0)
    throw error
  }
}

/** Lee el único artefacto privado ya preparado; /archivo nunca consulta Discord. */
export async function buildDiscordArchive(env: Env, attachmentSizeLimit?: number): Promise<ArchiveResponse> {
  const stored = await loadStoredArchive(env)
  if (!stored) throw new Error("Aún no hay una copia. Ejecuta la Acción «Sync Discord archive» en GitHub.")
  const markdown = renderSingleArchive(GUILD_ID, stored.archive, stored.omissions)
  const manifest = archiveManifest(GUILD_ID, stored.archive, stored.omissions, stored.generatedAt)
  const limit = Math.min(MAX_ARCHIVE_ATTACHMENT_BYTES, attachmentSizeLimit && attachmentSizeLimit > 0 ? attachmentSizeLimit : MAX_ARCHIVE_ATTACHMENT_BYTES)
  enforceArchiveSize("archivo-discord.md", markdown, limit)
  enforceArchiveSize("manifest.json", manifest, limit)
  return {
    content: `Archivo de Discord sincronizado: ${stored.archive.length} canales/hilos · ${stored.omissions.length ? "**parcial**; consulta el manifiesto" : "completo"} · última copia ${stored.generatedAt}. Solo tú puedes ver estos adjuntos.`,
    files: [
      { name: "archivo-discord.md", description: "Historial Markdown del servidor", content: markdown, contentType: "text/markdown; charset=utf-8" },
      { name: "manifest.json", description: "Estado y omisiones de la exportación", content: manifest, contentType: "application/json" },
    ],
  }
}
