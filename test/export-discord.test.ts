import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { tmpdir } from "node:os"
import { assertSafeContextOutput, collectArchive, collectArchiveWithStatus, fetchAllMessages, outputPath, renderChannel, renderIndex, writeArchive, type ArchiveOptions, type DiscordMessage } from "../scripts/export-discord.ts"

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const GUILD = "100000000000000001"
const TEXT = "100000000000000002"
const FORUM = "100000000000000003"
const ACTIVE = "100000000000000004"
const ACTIVE_PRIVATE = "100000000000000005"
const ARCHIVED = "100000000000000006"
const JOINED_NEW = "100000000000000007"
const JOINED_OLD = "100000000000000008"
const PRIVATE_NEW = "100000000000000009"
const PRIVATE_OLD = "100000000000000010"

function message(id: string, timestamp: string): DiscordMessage {
  return { id, channel_id: TEXT, timestamp, content: id, author: { username: "ana" } }
}

test("pagina el historial con before y devuelve los mensajes de más antiguo a más reciente", async () => {
  const newestPage = Array.from({ length: 100 }, (_, index) => message(`100000000000000${String(100 - index).padStart(3, "0")}`, `2026-10-21T${String(100 - index).padStart(2, "0")}:00:00.000Z`))
  const calls: string[] = []
  const options: ArchiveOptions = {
    token: "test",
    guildId: GUILD,
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      return response(url.includes("before=100000000000000001") ? [message("100000000000000000", "2026-10-20T00:00:00.000Z")] : newestPage)
    },
  }
  const messages = await fetchAllMessages(options, TEXT)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /messages\?limit=100$/)
  assert.match(calls[1], /before=100000000000000001/)
  assert.deepEqual(messages.slice(0, 2).map((item) => item.id), ["100000000000000000", "100000000000000001"])
})

test("respeta retry_after cuando Discord limita una ruta", async () => {
  let attempts = 0
  const warnings: string[] = []
  const messages = await fetchAllMessages({
    token: "test",
    guildId: GUILD,
    warn: (warning) => warnings.push(warning),
    fetch: async () => {
      attempts++
      return attempts === 1 ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }) : response([])
    },
  }, TEXT)
  assert.deepEqual(messages, [])
  assert.equal(attempts, 2)
  assert.match(warnings[0], /Límite de Discord/)
})

test("incluye canales, hilos activos y archivados públicos/privados; omite los no legibles", async () => {
  const warnings: string[] = []
  const options: ArchiveOptions = {
    token: "test",
    guildId: GUILD,
    warn: (warning) => warnings.push(warning),
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([
        { id: TEXT, type: 0, name: "general", position: 1 },
        { id: FORUM, type: 15, name: "tareas", position: 2 },
      ])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [{ id: ACTIVE, type: 11, name: "abierto", parent_id: FORUM }, { id: ACTIVE_PRIVATE, type: 12, name: "privado abierto", parent_id: TEXT }] })
      if (url.includes(`/channels/${TEXT}/threads/archived/public`)) return response({ threads: [], has_more: false })
      if (url.includes(`/channels/${TEXT}/threads/archived/private`)) return response({ threads: [], has_more: false })
      if (url.includes(`/channels/${FORUM}/threads/archived/public`)) {
        return response({ threads: [{ id: ARCHIVED, type: 11, name: "cerrado", parent_id: FORUM, thread_metadata: { archive_timestamp: "2026-10-20T00:00:00.000Z" } }], has_more: false })
      }
      if (url.includes(`/channels/${ACTIVE}/messages`)) return new Response("forbidden", { status: 403 })
      if (url.includes(`/channels/${TEXT}/messages`)) return response([message("100000000000000101", "2026-10-20T01:00:00.000Z")])
      if (url.includes(`/channels/${ARCHIVED}/messages`)) return response([{ ...message("100000000000000102", "2026-10-20T02:00:00.000Z"), channel_id: ARCHIVED }])
      if (url.includes(`/channels/${ACTIVE_PRIVATE}/messages`)) return response([{ ...message("100000000000000103", "2026-10-20T03:00:00.000Z"), channel_id: ACTIVE_PRIVATE }])
      return new Response("unexpected " + url, { status: 500 })
    },
  }
  const archive = await collectArchive(options)
  assert.deepEqual(archive.map((item) => item.channel.id), [TEXT, ACTIVE_PRIVATE, ARCHIVED])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /abierto/)
})

test("pagina los privados archivados por fecha y usa los privados unidos si falta MANAGE_THREADS", async () => {
  const warnings: string[] = []
  const calls: string[] = []
  const collection = await collectArchiveWithStatus({
    token: "test",
    guildId: GUILD,
    warn: (warning) => warnings.push(warning),
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([{ id: TEXT, type: 0, name: "general" }])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [] })
      if (url.includes("/archived/public")) return response({ threads: [], has_more: false })
      if (url.includes("/users/@me/threads/archived/private")) {
        if (url.includes(`before=${JOINED_NEW}`)) return response({ threads: [{ id: JOINED_OLD, type: 12, name: "antiguo", parent_id: TEXT }], has_more: false })
        return response({ threads: [{ id: JOINED_NEW, type: 12, name: "nuevo", parent_id: TEXT }], has_more: true })
      }
      if (url.includes("/threads/archived/private")) return new Response("missing MANAGE_THREADS", { status: 403 })
      if (url.includes(`/channels/${TEXT}/messages`)) return response([])
      if (url.includes(`/channels/${JOINED_NEW}/messages`) || url.includes(`/channels/${JOINED_OLD}/messages`)) return response([])
      return new Response("unexpected " + url, { status: 500 })
    },
  })
  assert.deepEqual(collection.archive.map((item) => item.channel.id), [TEXT, JOINED_NEW, JOINED_OLD])
  assert.equal(collection.omissions.length, 1)
  assert.match(warnings[0], /archived-private-threads/)
  assert.ok(calls.some((url) => url.includes(`/users/@me/threads/archived/private?limit=100&before=${JOINED_NEW}`)))
})

test("marca como parcial los fallos al enumerar un contenedor y sigue con sus mensajes", async () => {
  const collection = await collectArchiveWithStatus({
    token: "test",
    guildId: GUILD,
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([{ id: TEXT, type: 0, name: "general" }])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [] })
      if (url.includes("/archived/public")) return new Response("forbidden", { status: 403 })
      if (url.includes("/threads/archived/private")) return response({ threads: [], has_more: false })
      if (url.includes(`/channels/${TEXT}/messages`)) return response([])
      return new Response("unexpected " + url, { status: 500 })
    },
  })
  assert.deepEqual(collection.archive.map((item) => item.channel.id), [TEXT])
  assert.equal(collection.omissions[0]?.operation, "archived-public-threads")
})

test("pagina los privados archivados por archive_timestamp cuando el bot tiene MANAGE_THREADS", async () => {
  const calls: string[] = []
  const archive = await collectArchive({
    token: "test",
    guildId: GUILD,
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([{ id: TEXT, type: 0, name: "general" }])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [] })
      if (url.includes("/archived/public")) return response({ threads: [], has_more: false })
      if (url.includes("/threads/archived/private")) {
        if (url.includes("before=2026-10-20T00%3A00%3A00.000Z")) return response({ threads: [{ id: PRIVATE_OLD, type: 12, name: "antiguo", parent_id: TEXT, thread_metadata: { archive_timestamp: "2026-10-19T00:00:00.000Z" } }], has_more: false })
        return response({ threads: [{ id: PRIVATE_NEW, type: 12, name: "nuevo", parent_id: TEXT, thread_metadata: { archive_timestamp: "2026-10-20T00:00:00.000Z" } }], has_more: true })
      }
      if (url.includes(`/channels/${TEXT}/messages`) || url.includes(`/channels/${PRIVATE_NEW}/messages`) || url.includes(`/channels/${PRIVATE_OLD}/messages`)) return response([])
      return new Response("unexpected " + url, { status: 500 })
    },
  })
  assert.deepEqual(archive.map((item) => item.channel.id), [TEXT, PRIVATE_NEW, PRIVATE_OLD])
  assert.ok(calls.some((url) => url.includes("/threads/archived/private?limit=100&before=2026-10-20T00%3A00%3A00.000Z")))
})

test("solo acepta salidas nuevas bajo context/", () => {
  assert.match(outputPath("context/discord-2026-10-21"), /bot\/context\/discord-2026-10-21$/)
  assert.throws(() => outputPath("context"), /dentro de bot\/context/)
  assert.throws(() => outputPath("."), /dentro de bot\/context/)
  assert.throws(() => outputPath("otro"), /dentro de bot\/context/)
})

test("rechaza IDs no válidos antes de convertirlos en una ruta de Discord", async () => {
  let calls = 0
  await assert.rejects(() => fetchAllMessages({ token: "test", guildId: GUILD, fetch: async () => {
    calls++
    return response([])
  } }, "../fuera"), /snowflake/)
  assert.equal(calls, 0)
})

test("marca como parcial una lista raíz inaccesible y no parece un archivo completo vacío", async () => {
  const collection = await collectArchiveWithStatus({
    token: "test",
    guildId: GUILD,
    fetch: async (input) => String(input).endsWith(`/guilds/${GUILD}/threads/active`)
      ? response({ threads: [] })
      : new Response("forbidden", { status: 403 }),
  })
  assert.deepEqual(collection.archive, [])
  assert.equal(collection.omissions[0]?.operation, "channels")
  assert.match(renderIndex(GUILD, collection.archive, collection.omissions), /Estado: \*\*parcial\*\*/)
})

test("no itera cuando el cursor de mensajes se repite", async () => {
  const page = Array.from({ length: 100 }, (_, index) => message(`100000000000001${String(index).padStart(3, "0")}`, "2026-10-21T08:00:00.000Z"))
  await assert.rejects(() => fetchAllMessages({ token: "test", guildId: GUILD, fetch: async () => response(page) }, TEXT), /no avanza/)
})

test("registra IDs de canal inválidos sin usarlos en rutas ni archivos", async () => {
  const calls: string[] = []
  const collection = await collectArchiveWithStatus({
    token: "test",
    guildId: GUILD,
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([{ id: "../../fuera", type: 0, name: "malicioso" }])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [] })
      return response([])
    },
  })
  assert.deepEqual(collection.archive, [])
  assert.equal(collection.omissions[0]?.channelId, "../../fuera")
  assert.ok(calls.every((url) => !url.includes("../../fuera")))
})

test("avisa si todos los mensajes normales llegaron sin contenido", async () => {
  const collection = await collectArchiveWithStatus({
    token: "test",
    guildId: GUILD,
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith(`/guilds/${GUILD}/channels`)) return response([{ id: TEXT, type: 0, name: "general" }])
      if (url.endsWith(`/guilds/${GUILD}/threads/active`)) return response({ threads: [] })
      if (url.includes("/threads/archived/")) return response({ threads: [], has_more: false })
      if (url.includes(`/channels/${TEXT}/messages`)) return response([{ ...message("100000000000000120", "2026-10-21T08:00:00.000Z"), content: "" }])
      return new Response("unexpected " + url, { status: 500 })
    },
  })
  assert.ok(collection.omissions.some((omission) => /Message Content/.test(omission.reason)))
})

test("rechaza --out que atraviesa un enlace simbólico desde context", async () => {
  const root = await mkdtemp(join(tmpdir(), "gtt-export-outside-"))
  const context = dirname(outputPath("context/seguro"))
  const link = join(context, `.test-escape-${process.pid}`)
  await mkdir(context, { recursive: true })
  try {
    await symlink(root, link)
    await assert.rejects(() => assertSafeContextOutput(join(link, "archivo")), /enlace simbólico/)
  } finally {
    await rm(link, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("publica el archivo de una vez con manifiesto y nunca sobrescribe un destino", async () => {
  const root = await mkdtemp(join(tmpdir(), "gtt-export-"))
  const output = join(root, "discord")
  try {
    await writeArchive(output, GUILD, [{ channel: { id: TEXT, type: 0, name: "general" }, messages: [] }], [{ target: "#privado", operation: "messages", reason: "403", channelId: TEXT }])
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { partial: boolean; omissions: unknown[] }
    assert.equal(manifest.partial, true)
    assert.equal(manifest.omissions.length, 1)
    await assert.rejects(() => writeArchive(output, GUILD, []), /no se sobrescribe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("el Markdown conserva la fuente sin activar URLs inseguras y el índice es estable", () => {
  const archived = {
    channel: { id: TEXT, type: 0, name: "general" },
    messages: [{
      id: "100000000000000111",
      channel_id: TEXT,
      timestamp: "2026-10-21T08:00:00.000Z",
      content: "[enlace malicioso](javascript:alert(1))",
      author: { global_name: "Ana *" },
      embeds: [{ title: "prueba", url: "javascript:alert(1)", description: "descripción" }],
      attachments: [{ filename: "archivo.md", url: "file:///secreto", size: 42 }],
    }],
  }
  const markdown = renderChannel(GUILD, archived)
  assert.match(markdown, /~~~text\n\[enlace malicioso\]\(javascript:alert\(1\)\)\n~~~/)
  assert.match(markdown, /URL omitida/)
  assert.doesNotMatch(markdown, /\]\(<(?:javascript|file):/)
  assert.match(markdown, new RegExp(`https://discord\\.com/channels/${GUILD}/${TEXT}/100000000000000111`))
  assert.equal(renderIndex(GUILD, [archived]), renderIndex(GUILD, [archived]))
  assert.match(renderIndex(GUILD, [archived], [{ target: "#a|b", operation: "messages", reason: "falló\ncon detalle", channelId: TEXT }]), /Estado: \*\*parcial\*\*/)
})
