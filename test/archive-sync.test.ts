import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchMessagesSince, type ArchiveOptions, type DiscordMessage } from "../src/archive.ts"
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
