import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchMessagesSince, humanMessagesLookStripped, type ArchiveOptions, type DiscordMessage } from "../src/archive.ts"
import { syncDiscordArchive } from "../src/archivo.ts"
import { getPrivateText, putPrivateObject } from "../src/supabase.ts"
import type { Env } from "../src/discord.ts"
import { GUILD_ID } from "../src/config.ts"

const GUILD = "100000000000000001"
const CHANNEL = "100000000000000002"
const CURSOR = "100000000000000200"

function message(id: string): DiscordMessage {
  return { id, channel_id: CHANNEL, timestamp: new Date(Date.UTC(2026, 9, 21, 0, 0, Number(id.slice(-3)))).toISOString(), content: id, author: { username: "ana" } }
}

test("la actualización incremental pagina hacia atrás con before hasta alcanzar el cursor", async () => {
  const calls: string[] = []
  const newest = Array.from({ length: 100 }, (_, index) => message(`100000000000000${String(400 - index).padStart(3, "0")}`))
  // La segunda página incluye el cursor: no debe pedirse una tercera ni añadirlo.
  const older = [message("100000000000000201"), message(CURSOR), message("100000000000000199")]
  const options: ArchiveOptions = {
    token: "token", guildId: GUILD,
    fetch: async (input) => {
      const url = String(input); calls.push(url)
      return new Response(JSON.stringify(url.includes("before=100000000000000301") ? older : newest), { status: 200 })
    },
  }
  const messages = await fetchMessagesSince(options, CHANNEL, CURSOR)
  assert.equal(calls.length, 2)
  assert.match(calls[0], /messages\?limit=100$/)
  assert.match(calls[1], /before=100000000000000301/)
  assert.equal(messages.length, 101)
  assert.equal(messages[0]?.id, "100000000000000201")
  assert.equal(messages.at(-1)?.id, "100000000000000400")
  assert.ok(messages.every((item) => BigInt(item.id) > BigInt(CURSOR)))
})

test("Storage usa el endpoint autenticado para leer y el secreto no aparece en la URL", async () => {
  const env: Env = {
    DISCORD_PUBLIC_KEY: "", DISCORD_APPLICATION_ID: "app", DISCORD_BOT_TOKEN: "token",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
  }
  const original = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response("{\"ok\":true}", { status: 200 })
  }) as typeof fetch
  try {
    assert.equal(await getPrivateText(env, "latest.json"), "{\"ok\":true}")
    await putPrivateObject(env, "snapshots/1-test/manifest.json", "{}", "application/json")
  } finally {
    globalThis.fetch = original
  }
  assert.match(calls[0]!.url, /\/storage\/v1\/object\/authenticated\/discord-archives\/latest\.json\?cache=/)
  assert.equal(calls[0]!.init?.headers instanceof Headers && calls[0]!.init.headers.get("Authorization"), "Bearer sb_secret_test")
  assert.doesNotMatch(calls[0]!.url, /sb_secret_test/)
  assert.equal(calls[1]!.init?.method, "POST")
  assert.match(calls[1]!.url, /\/storage\/v1\/object\/discord-archives\/snapshots\/1-test\/manifest\.json$/)
})

test("Storage trata el 400 con NoSuchKey como objeto inexistente y el resto de 400 como error", async () => {
  const env: Env = {
    DISCORD_PUBLIC_KEY: "", DISCORD_APPLICATION_ID: "app", DISCORD_BOT_TOKEN: "token",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
  }
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("missing.json")
    ? new Response("{\"statusCode\":\"404\",\"error\":\"not_found\",\"message\":\"Object not found\",\"code\":\"NoSuchKey\"}", { status: 400 })
    : new Response("{\"statusCode\":\"400\",\"error\":\"InvalidRequest\"}", { status: 400 })) as typeof fetch
  try {
    assert.equal(await getPrivateText(env, "missing.json"), undefined)
    await assert.rejects(getPrivateText(env, "bad.json"), /400/)
  } finally {
    globalThis.fetch = original
  }
})

test("la primera sincronización sustituye un único objeto privado, sin snapshots", async () => {
  const env: Env = {
    DISCORD_PUBLIC_KEY: "", DISCORD_APPLICATION_ID: "app", DISCORD_BOT_TOKEN: "token",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
  }
  const original = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init })
    if (url.includes("/storage/v1/object/authenticated/discord-archives/latest-archive.json")) return new Response("missing", { status: 404 })
    if (url.includes("/storage/v1/object/authenticated/discord-archives/archive-health.json")) return new Response("missing", { status: 404 })
    if (url.endsWith(`/guilds/${GUILD_ID}/channels`)) return new Response("[]", { status: 200 })
    if (url.endsWith(`/guilds/${GUILD_ID}/threads/active`)) return new Response("{\"threads\":[]}", { status: 200 })
    if (init?.method === "POST" && url.includes("/storage/v1/object/discord-archives/")) return new Response("{}", { status: 200 })
    return new Response(`unexpected ${url}`, { status: 500 })
  }) as typeof fetch
  try {
    const result = await syncDiscordArchive(env)
    assert.equal(result.created, true)
    assert.equal(result.saved, true)
    assert.equal(result.added, 0)
  } finally {
    globalThis.fetch = original
  }
  // Una única copia del archivo (sobrescrita) más su estado de salud: ningún snapshot.
  const uploads = calls.filter((call) => call.init?.method === "POST")
  assert.equal(uploads.length, 2)
  assert.match(uploads[0]!.url, /\/storage\/v1\/object\/discord-archives\/latest-archive\.json$/)
  assert.equal(uploads[0]!.init?.headers instanceof Headers && uploads[0]!.init.headers.get("x-upsert"), "true")
  assert.match(uploads[1]!.url, /\/storage\/v1\/object\/discord-archives\/archive-health\.json$/)
})

test("el resumen diario del bot (solo embed) no se toma por el intent Message Content desactivado", () => {
  const summary: DiscordMessage = { ...message("100000000000000301"), content: "", author: { username: "GTT", bot: true }, embeds: [{ title: "Resumen GTT" }] }
  assert.equal(humanMessagesLookStripped([summary]).stripped, false)
  // Una persona que solo sube una imagen tampoco es una señal de contenido borrado.
  const image: DiscordMessage = { ...message("100000000000000302"), content: "", attachments: [{ filename: "captura.png" }] }
  assert.equal(humanMessagesLookStripped([summary, image]).stripped, false)
})

test("mensajes de personas vacíos del todo sí delatan el intent Message Content desactivado", () => {
  const stripped: DiscordMessage = { ...message("100000000000000303"), content: "" }
  assert.deepEqual(humanMessagesLookStripped([stripped, { ...stripped, id: "100000000000000304" }]), { stripped: true, human: 2 })
  assert.equal(humanMessagesLookStripped([stripped, message("100000000000000305")]).stripped, false)
})
