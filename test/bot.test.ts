import assert from "node:assert/strict"
import { test } from "node:test"
import { clip, editOriginal, editOriginalWithFiles, type Env, readOptions, verifySignature } from "../src/discord.ts"
import { canDownloadArchive } from "../src/archivo.ts"
import { ARCHIVE_ROLE_ID, GUILD_ID } from "../src/config.ts"
import bot from "../src/index.ts"
import { experimentEmbed, safeUrl, vsBaseline } from "../src/experimento.ts"
import { ago, countdown, logLine, parseFrontMatter } from "../src/info.ts"
import { summary } from "../src/resumen.ts"
import { canonical, countByStatus, createTask, firstMention, replaceStatus } from "../src/tareas.ts"

const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex")

test("acepta firmas válidas de Discord y rechaza las manipuladas", async () => {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
  const publicKey = hex((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer)
  const body = JSON.stringify({ type: 1 })
  const ts = "1729500000"
  const sig = hex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body)))
  assert.equal(await verifySignature(body, sig, ts, publicKey), true)
  assert.equal(await verifySignature(body + " ", sig, ts, publicKey), false)
  assert.equal(await verifySignature(body, null, ts, publicKey), false)
})

test("aplana subcomandos y opciones", () => {
  const { sub, values } = readOptions([{ name: "crear", type: 1, options: [{ name: "titulo", type: 3, value: "EDA" }] }])
  assert.equal(sub, "crear")
  assert.deepEqual(values, { titulo: "EDA" })
})

test("/archivo discord exige el rol GTT Team y el servidor configurado", () => {
  const interaction = { type: 2, token: "t", guild_id: GUILD_ID, member: { user: { id: "u", username: "ana" }, roles: [ARCHIVE_ROLE_ID] } }
  assert.equal(canDownloadArchive(interaction), true)
  assert.equal(canDownloadArchive({ ...interaction, member: { ...interaction.member, roles: [] } }), false)
  assert.equal(canDownloadArchive({ ...interaction, guild_id: "100000000000000001" }), false)
  assert.equal(canDownloadArchive({ ...interaction, member: undefined }), false)
})

test("cuenta atrás hasta el 17-nov", () => {
  assert.match(countdown(new Date("2026-10-21T08:00:00Z")), /Quedan \*\*27 días y 14 h\*\*/)
  assert.match(countdown(new Date("2026-11-17T12:00:00Z")), /Hoy es el día/)
  assert.match(countdown(new Date("2026-11-18T00:00:00Z")), /ya está entregada/)
})

test("cambiar de estado conserva el área y quita el estado anterior", () => {
  const tags = [
    { id: "1", name: "To do" },
    { id: "2", name: "En curso" },
    { id: "9", name: "Datos" },
  ]
  assert.deepEqual(replaceStatus(["1", "9"], tags, "En curso"), ["9", "2"])
  assert.throws(() => replaceStatus([], tags, "Inexistente"))
})

test("lee el responsable del primer mensaje", () => {
  assert.equal(firstMention("**Responsable:** <@123456>\n**Área:** Datos"), "123456")
  assert.equal(firstMention("sin mención"), undefined)
})

test("cuenta tareas por estado", () => {
  const line = countByStatus([
    { id: "a", name: "a", status: "To do" },
    { id: "b", name: "b", status: "To do" },
    { id: "c", name: "c", status: "Hecho" },
  ])
  assert.match(line, /To do \*\*2\*\*/)
  assert.match(line, /Hecho \*\*1\*\*/)
})

test("compara spellF1 solo con el baseline del mismo split", () => {
  assert.match(vsBaseline(0.25, "full-match"), /\+0\.0067 vs baseline smooth50 \(0\.2433, full-match\)/)
  assert.match(vsBaseline(0.3, "public-5min"), /−0\.0256 .*0\.3256/)
  assert.match(vsBaseline(0.3, undefined), /indica el split/)
})

test("avisa al usar la ventana pública", () => {
  const embed = experimentEmbed({ titulo: "Viterbi", hipotesis: "menos parpadeo", resultado: "mixed", spellf1: 0.4, split: "public-5min" }, "1")
  assert.ok(embed.fields?.some((f) => f.name.includes("Ojo")))
  assert.equal(embed.url, undefined)
})

test("lee la cabecera de una entrada del log", () => {
  const meta = parseFrontMatter('---\ntitle: "Reading the challenge"\ntype: study\nauthors: [jimy-k4]\n---\n\n## Context')
  assert.equal(meta.title, "Reading the challenge")
  assert.equal(meta.type, "study")
  assert.equal(
    logLine({ date: "2026-10-20", slug: "reading-the-challenge", title: meta.title, type: meta.type }),
    "`2026-10-20` [Reading the challenge](https://gtt-talentarena.github.io/log/reading-the-challenge/) · *study*",
  )
})

test("tiempo relativo", () => {
  const now = new Date("2026-10-21T10:00:00Z")
  assert.equal(ago("2026-10-21T09:30:00Z", now), "hace 30 min")
  assert.equal(ago("2026-10-21T07:00:00Z", now), "hace 3 h")
  assert.equal(ago("2026-10-17T10:00:00Z", now), "hace 4 días")
})

// ── Con fetch simulado: Discord y GitHub ─────────────────────────────────────────────

const env: Env = { DISCORD_PUBLIC_KEY: "", DISCORD_APPLICATION_ID: "app", DISCORD_BOT_TOKEN: "t" }
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

function mockFetch(route: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return route(url, init)
  }) as typeof fetch
  return calls
}

const TAGS = [
  { id: "s1", name: "To do" },
  { id: "s2", name: "En curso" },
  { id: "s3", name: "Bloqueado" },
  { id: "a1", name: "Datos" },
]

test("clip nunca pasa del límite", () => {
  const text = clip(Array.from({ length: 50 }, (_, i) => `línea ${i} ${"x".repeat(80)}`), 1000)
  assert.ok(text.length <= 1000, `${text.length}`)
  assert.match(text, /…y \d+ más$/)
})

test("el resumen respeta los límites de Discord con muchas PRs y tareas", async () => {
  const longTitle = "Una PR con un título larguísimo ".repeat(8)
  mockFetch((url) => {
    if (url.includes("/pulls")) {
      return ok(Array.from({ length: 6 }, (_, n) => ({ number: n, title: longTitle, html_url: `https://github.com/x/y/pull/${n}`, draft: false, user: { login: "jimy-k4" } })))
    }
    if (url.includes("/actions/workflows")) return ok({ workflow_runs: [] })
    if (url.includes("/contents/content/log")) return ok([])
    if (url.endsWith("/channels/1562077480624324669")) return ok({ available_tags: TAGS })
    if (url.includes("/threads/active")) {
      return ok({ threads: Array.from({ length: 40 }, (_, n) => ({ id: `${1000 + n}`, name: `t${n}`, parent_id: "1562077480624324669", applied_tags: [n % 2 ? "s2" : "s3", "a1"] })) })
    }
    if (url.includes("/threads/archived")) return ok({ threads: [], has_more: false })
    if (url.includes("/messages/")) return ok({ content: "**Responsable:** <@123456789012345678>" })
    return new Response("?", { status: 404 })
  })
  const msg = await summary(env, new Date("2026-10-21T08:00:00Z"))
  const embed = msg.embeds![0]
  for (const f of embed.fields!) assert.ok(f.value.length <= 1024, `${f.name}: ${f.value.length}`)
  assert.ok(embed.fields!.length <= 25)
  assert.match(embed.fields![0].value, /parcial/) // 40 abiertas > 35 responsables leídos
  assert.deepEqual(msg.allowed_mentions, { parse: [] })
})

test("si Discord rechaza la edición, se reintenta con texto simple", async () => {
  const calls = mockFetch((_url, init) => (JSON.parse(String(init?.body)).embeds ? new Response("bad", { status: 400 }) : new Response(null, { status: 200 })))
  const errors: unknown[] = []
  const original = console.error
  console.error = (e: unknown) => errors.push(e)
  await editOriginal(env, "tok", { embeds: [{ title: "x" }] })
  console.error = original
  assert.equal(calls.length, 2)
  assert.match(String(calls[1].init?.body), /No he podido mostrar/)
  assert.equal(errors.length, 1)
})

test("el archivo efímero se edita con multipart payload_json y files[n]", async () => {
  const calls = mockFetch(() => new Response(null, { status: 200 }))
  await editOriginalWithFiles(env, "tok", { content: "privado", allowed_mentions: { parse: [] } }, [
    { name: "archivo-discord.md", description: "historial", content: "# privado", contentType: "text/markdown" },
    { name: "manifest.json", content: "{}", contentType: "application/json" },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init?.method, "PATCH")
  const form = calls[0].init?.body
  assert.ok(form instanceof FormData)
  const payload = JSON.parse(String(form.get("payload_json"))) as { content: string; attachments: { id: number; filename: string; description?: string }[] }
  assert.equal(payload.content, "privado")
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "archivo-discord.md", description: "historial" }, { id: 1, filename: "manifest.json" }])
  assert.equal(await (form.get("files[0]") as Blob).text(), "# privado")
})

test("/archivo discord difiere de forma efímera y adjunta la copia privada sin volver a leer Discord", async () => {
  const calls = mockFetch((url) => {
    if (url.includes("/storage/v1/object/authenticated/discord-archives/latest-archive.json")) return ok({
      version: 2, generatedAt: "2026-10-21T12:15:00.000Z", guildId: GUILD_ID, omissions: [],
      archive: [{ channel: { id: "1562076469679886440", type: 0, name: "general" }, messages: [] }],
    })
    if (url.includes("/webhooks/app/tok/messages/@original")) return new Response(null, { status: 200 })
    return new Response(`unexpected ${url}`, { status: 500 })
  })
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer)
  const body = JSON.stringify({ type: 2, token: "tok", guild_id: GUILD_ID, attachment_size_limit: 1024 * 1024, member: { user: { id: "u", username: "ana" }, roles: [ARCHIVE_ROLE_ID] }, data: { name: "archivo", options: [{ type: 1, name: "discord" }] } })
  const timestamp = "1729500000"
  const signature = hex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)))
  let pending: Promise<unknown> | undefined
  const ctx = { waitUntil(promise: Promise<unknown>) { pending = promise }, passThroughOnException() {} } as ExecutionContext
  const response = await bot.fetch(new Request("https://worker.example", { method: "POST", headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp }, body }), { ...env, DISCORD_PUBLIC_KEY: publicKey, SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" }, ctx)
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } })
  await pending
  const form = calls.find((call) => call.url.includes("/webhooks/app/tok/messages/@original"))?.init?.body
  assert.ok(form instanceof FormData)
  assert.equal(JSON.parse(String(form.get("payload_json"))).attachments.length, 2)
  assert.match(await (form.get("files[0]") as Blob).text(), /Archivo de Discord/)
  assert.ok(calls.every((call) => !call.url.includes("discord.com/api/v10/guilds/")))
})

test("una tarea solo hace ping al responsable, aunque el detalle diga @everyone", async () => {
  const calls = mockFetch((url) => (url.endsWith("/threads") ? ok({ id: "777" }) : ok({ available_tags: TAGS })))
  await createTask(env, { titulo: "EDA", responsable: "42", area: "Datos", detalle: "@everyone mirad esto" }, "1")
  const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/threads"))!.init!.body))
  assert.deepEqual(body.message.allowed_mentions, { users: ["42"] })
  assert.deepEqual(body.applied_tags, ["s1", "a1"])
})

test("etiquetas sin distinguir mayúsculas", () => {
  assert.equal(canonical("en Curso", ["To do", "En curso"]), "En curso")
  assert.deepEqual(replaceStatus(["x", "a1"], [{ id: "x", name: "to do" }, { id: "y", name: "En curso" }, ...TAGS.slice(3)], "En curso"), ["a1", "y"])
})

test("solo URLs http(s) válidas como enlace del experimento", () => {
  assert.equal(safeUrl("https://github.com/GTT-TalentArena/more-than-a-hack-2027/pull/3"), "https://github.com/GTT-TalentArena/more-than-a-hack-2027/pull/3")
  assert.equal(safeUrl("httpfoo bar"), undefined)
  assert.equal(safeUrl("javascript:alert(1)"), undefined)
  const embed = experimentEmbed({ titulo: "x", hipotesis: "y", resultado: "open", enlace: "github.com/x" }, "1")
  assert.equal(embed.url, undefined)
  assert.ok(embed.fields?.some((f) => f.name === "Enlace"))
})
