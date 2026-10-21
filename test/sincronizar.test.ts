import assert from "node:assert/strict"
import { test } from "node:test"
import { CHANNELS, GUILD_ID } from "../src/config.ts"
import type { Env } from "../src/discord.ts"
import { parseProject, type ProjectItem } from "../src/proyecto.ts"
import { cost, type Post, reconcile, retag, snowflakeTime, type Synced, syncTasks } from "../src/sincronizar.ts"
import { issueNumber, taskContent, threadName } from "../src/tareas.ts"

const TAGS = [
  { id: "t-todo", name: "To do" },
  { id: "t-curso", name: "En curso" },
  { id: "t-review", name: "Review" },
  { id: "t-bloq", name: "Bloqueado" },
  { id: "t-hecho", name: "Hecho" },
  { id: "t-datos", name: "Datos" },
  { id: "t-algo", name: "Algoritmos" },
]

const item = (over: Partial<ProjectItem> = {}): ProjectItem => ({
  itemId: "item-12",
  issueId: "issue-12",
  number: 12,
  title: "P0 - Pipeline",
  url: "https://github.com/GTT-TalentArena/more-than-a-hack-2027/issues/12",
  assignees: ["hxst1"],
  milestone: "M0",
  status: "En curso",
  area: "Infra",
  ...over,
})
const post = (over: Partial<Post> = {}): Post => ({
  id: "200000000000000012",
  name: "#12 · P0 - Pipeline",
  status: "En curso",
  area: "Infra",
  archived: false,
  applied: [],
  ownedByBot: true,
  ...over,
})
const synced = (over: Partial<Synced> = {}): Synced => ({
  thread: "200000000000000012",
  status: "En curso",
  area: "Infra",
  title: "P0 - Pipeline",
  assignees: ["hxst1"],
  milestone: "M0",
  content: taskContent(item()),
  ...over,
})

test("el post se titula «#N · título» y el número se recupera del nombre", () => {
  assert.equal(threadName({ number: 7, title: "Docker" }), "#7 · Docker")
  assert.equal(issueNumber("#7 · Docker"), 7)
  assert.equal(issueNumber("Docker #7"), undefined)
  assert.ok(threadName({ number: 1, title: "x".repeat(200) }).length <= 100)
})

test("sin cambios en ningún lado no se hace nada", () => {
  const plan = reconcile(item(), post(), synced())
  assert.deepEqual(plan.discord, {})
  assert.deepEqual(plan.github, {})
  assert.equal(cost(plan, post()), 0)
})

test("un cambio de estado en GitHub baja a Discord", () => {
  const plan = reconcile(item({ status: "Review" }), post(), synced())
  assert.deepEqual(plan.discord, { status: "Review" })
  assert.deepEqual(plan.github, {})
  assert.equal(plan.next.status, "Review")
})

test("un cambio de etiqueta en Discord sube a GitHub", () => {
  const plan = reconcile(item(), post({ status: "Bloqueado", area: "Datos" }), synced())
  assert.deepEqual(plan.github, { status: "Bloqueado", area: "Datos" })
  assert.deepEqual(plan.discord, {})
  assert.equal(plan.next.status, "Bloqueado")
})

test("si cambian los dos lados a la vez gana GitHub", () => {
  const plan = reconcile(item({ status: "Hecho" }), post({ status: "Bloqueado" }), synced())
  assert.deepEqual(plan.discord, { status: "Hecho" })
  assert.deepEqual(plan.github, {})
})

test("quitar el área en Discord la vacía en GitHub; quitar el estado lo restaura", () => {
  assert.deepEqual(reconcile(item(), post({ area: undefined }), synced()).github, { area: null })
  const plan = reconcile(item(), post({ status: undefined }), synced())
  assert.deepEqual(plan.discord, { status: "En curso" })
  assert.deepEqual(plan.github, {})
})

test("un post sin historial se alinea con GitHub sin subir nada", () => {
  const plan = reconcile(item(), post({ status: "To do" }), undefined)
  assert.deepEqual(plan.discord.status, "En curso")
  assert.deepEqual(plan.github, {})
})

test("título y asignados van de GitHub a Discord; el mensaje solo se edita si es del bot", () => {
  const plan = reconcile(item({ title: "P0 - Pipeline v2", assignees: ["jimy-k4", "alguien-de-fuera"] }), post(), synced())
  assert.equal(plan.discord.name, "#12 · P0 - Pipeline v2")
  // Con ID en TEAM sale como mención; sin él, como login
  assert.match(plan.discord.content ?? "", /\*\*Responsable:\*\* <@350599420909322250>, `alguien-de-fuera`/)
  assert.equal(reconcile(item({ assignees: ["jimy-k4"] }), post({ ownedByBot: false }), synced()).discord.content, undefined)
})

test("si cambia el texto que tocaría (p. ej. al rellenar TEAM), el mensaje se reescribe aunque no cambien los asignados", () => {
  const plan = reconcile(item(), post(), synced({ content: "**Responsable:** `hxst1`" }))
  assert.equal(plan.discord.content, taskContent(item()))
  assert.equal(plan.next.content, taskContent(item()))
}) 

test("retag cambia estado y área y conserva el resto de etiquetas", () => {
  assert.deepEqual(retag(["t-todo", "t-datos", "otra"], TAGS, { status: "Review" }), ["t-datos", "otra", "t-review"])
  assert.deepEqual(retag(["t-todo", "t-datos"], TAGS, { area: null }), ["t-todo"])
})

test("la fecha de un snowflake de Discord", () => {
  // ID del servidor GTT, creado el 20-oct-2026
  assert.equal(new Date(snowflakeTime(GUILD_ID)).toISOString().slice(0, 10), "2026-10-20")
})

test("parseProject traduce Status y Área e ignora lo que no es una issue del fork", () => {
  const { meta, items } = parseProject({
    organization: {
      projectV2: {
        id: "P",
        fields: { nodes: [{}, { id: "F-status", name: "Status", options: [{ id: "o1", name: "In Progress" }] }] },
        items: {
          nodes: [
            {
              id: "I1",
              fieldValues: { nodes: [{ name: "In Progress", field: { name: "Status" } }, {}] },
              content: { id: "N1", number: 12, title: "P0", url: "u", repository: { name: "more-than-a-hack-2027" }, assignees: { nodes: [{ login: "hxst1" }] }, milestone: null },
            },
            { id: "I2", fieldValues: { nodes: [] }, content: { id: "N2", number: 3, title: "web", url: "u", repository: { name: "otra" } } },
            { id: "I3", fieldValues: { nodes: [] }, content: null },
          ],
        },
      },
    },
  })
  assert.equal(meta.area, undefined)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], { itemId: "I1", issueId: "N1", number: 12, title: "P0", url: "u", createdAt: undefined, assignees: ["hxst1"], milestone: undefined, status: "En curso", area: undefined })
})

// Simula GitHub, Discord y Supabase para una pasada completa
function fakeWorld(threads: object[], opts: { stored?: string; hasMore?: boolean; failPatch?: RegExp } = {}) {
  const calls: { method: string; url: string; body?: string }[] = []
  let stored: string | undefined = opts.stored
  let nextIssue = 30
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : undefined
    calls.push({ method, url, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (method === "PATCH" && opts.failPatch?.test(url)) return json({ message: "Missing Permissions" }, 403)
    if (url.endsWith("/graphql")) {
      const query = JSON.parse(body!).query as string
      if (query.includes("projectV2(number")) {
        return json({ data: { organization: { projectV2: {
          id: "P",
          fields: { nodes: [
            { id: "F-status", name: "Status", options: [{ id: "o-todo", name: "Todo" }, { id: "o-prog", name: "In Progress" }] },
            { id: "F-area", name: "Área", options: [{ id: "o-datos", name: "Datos" }] },
          ] },
          items: { nodes: [{
            id: "I12",
            fieldValues: { nodes: [{ name: "In Progress", field: { name: "Status" } }] },
            content: { id: "N12", number: 12, title: "P0 - Pipeline", url: "https://github.com/x/12", repository: { name: "more-than-a-hack-2027" }, assignees: { nodes: [] }, milestone: null },
          }] },
        } } } })
      }
      if (query.includes("addProjectV2ItemById")) return json({ data: { addProjectV2ItemById: { item: { id: `I${nextIssue}` } } } })
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } } })
    }
    if (url.endsWith("/repos/GTT-TalentArena/more-than-a-hack-2027/issues")) {
      const { title } = JSON.parse(body!)
      return json({ node_id: `N${nextIssue}`, number: nextIssue, title, html_url: `https://github.com/x/${nextIssue}`, assignees: [] }, 201)
    }
    if (url.includes("task-sync.json")) {
      if (method === "GET") return stored ? new Response(stored) : json({ statusCode: "404", code: "NoSuchKey" }, 400)
      stored = body
      return json({})
    }
    if (url.endsWith(`/channels/${CHANNELS.tareas}`)) return json({ available_tags: TAGS })
    if (url.endsWith(`/guilds/${GUILD_ID}/threads/active`)) return json({ threads })
    if (url.includes("/threads/archived/public")) return json({ threads: [], has_more: opts.hasMore ?? false })
    if (method === "POST" && url.endsWith(`/channels/${CHANNELS.tareas}/threads`)) return json({ id: "300000000000000012", name: JSON.parse(body!).name })
    if (method === "GET" && /\/channels\/(\d+)\/messages\/\1$/.test(url)) return json({ content: "Hay que medir el ruido del bootstrap" })
    return json({})
  }) as typeof fetch
  return { calls, fetchMock, state: () => (stored ? JSON.parse(stored) : undefined) }
}

const env: Env = {
  DISCORD_PUBLIC_KEY: "", DISCORD_APPLICATION_ID: "999", DISCORD_BOT_TOKEN: "bot", GITHUB_TOKEN: "gh",
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test",
}

test("pasada completa: crea el post de la issue e importa un post nuevo del foro", async () => {
  // ID de un post creado después de la primera pasada (2027) y otro anterior (el propio servidor, 2026)
  const nuevo = String((BigInt(Date.parse("2027-01-01T00:00:00Z") - 1420070400000) << 22n) + 1n)
  const world = fakeWorld([
    { id: nuevo, name: "Medir ruido", parent_id: CHANNELS.tareas, applied_tags: ["t-datos"], owner_id: "555" },
    { id: GUILD_ID, name: "Post viejo", parent_id: CHANNELS.tareas, applied_tags: [], owner_id: "555" },
  ])
  const original = globalThis.fetch
  globalThis.fetch = world.fetchMock
  try {
    const result = await syncTasks(env, new Date("2026-12-31T00:00:00Z"))
    assert.deepEqual(result, { created: 1, imported: 1, updated: 0, pending: 0 })
  } finally {
    globalThis.fetch = original
  }

  const created = world.calls.find((c) => c.method === "POST" && c.url.endsWith(`/channels/${CHANNELS.tareas}/threads`))
  assert.deepEqual(JSON.parse(created!.body!).applied_tags, ["t-curso"])
  assert.equal(JSON.parse(created!.body!).name, "#12 · P0 - Pipeline")

  const issue = world.calls.find((c) => c.url.endsWith("/issues"))
  assert.equal(JSON.parse(issue!.body!).title, "Medir ruido")
  assert.match(JSON.parse(issue!.body!).body, /Hay que medir el ruido/)
  const renamed = world.calls.find((c) => c.method === "PATCH" && c.url.endsWith(`/channels/${nuevo}`))
  assert.deepEqual(JSON.parse(renamed!.body!), { name: "#30 · Medir ruido", applied_tags: ["t-datos", "t-todo"] })
  // El post anterior a la activación no se importa
  assert.equal(world.calls.filter((c) => c.url.endsWith("/issues")).length, 1)

  const state = world.state()
  assert.equal(state.items["12"].thread, "300000000000000012")
  assert.equal(state.items["30"].thread, nuevo)
  // Estado y área se guardan vacíos: la siguiente pasada sube las etiquetas del post al Project
  assert.equal(state.items["30"].status, undefined)
})

test("tras importar un post, sus etiquetas suben al Project en la pasada siguiente", () => {
  const imported = item({ number: 30, status: undefined, area: undefined, assignees: [], milestone: undefined, title: "Medir ruido" })
  const plan = reconcile(imported, post({ name: "#30 · Medir ruido", status: "To do", area: "Datos", ownedByBot: false }), synced({ status: undefined, area: undefined, title: "Medir ruido", assignees: [], milestone: undefined }))
  assert.deepEqual(plan.github, { status: "To do", area: "Datos" })
  assert.deepEqual(plan.discord, {})
})

async function withFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("si falla el renombrado al importar, la siguiente pasada no crea otra issue", async () => {
  const nuevo = String((BigInt(Date.parse("2027-01-01T00:00:00Z") - 1420070400000) << 22n) + 1n)
  const world = fakeWorld([{ id: nuevo, name: "Medir ruido", parent_id: CHANNELS.tareas, applied_tags: [], owner_id: "555" }], { failPatch: new RegExp(`/channels/${nuevo}$`) })
  await withFetch(world.fetchMock, () => syncTasks(env, new Date("2026-12-31T00:00:00Z")))
  await withFetch(world.fetchMock, () => syncTasks(env, new Date("2026-12-31T00:05:00Z")))
  assert.equal(world.calls.filter((c) => c.url.endsWith("/issues")).length, 1)
  assert.equal(world.state().items["30"].thread, nuevo)
})

test("si el post de una issue ya sincronizada no aparece y hay más archivados, no se duplica", async () => {
  const stored = JSON.stringify({ version: 1, since: "2026-10-21T00:00:00.000Z", items: { "12": synced({ thread: "400000000000000012" }) } })
  const world = fakeWorld([], { stored, hasMore: true })
  const result = await withFetch(world.fetchMock, () => syncTasks(env, new Date("2026-12-31T00:00:00Z")))
  assert.equal(result.created, 0)
  assert.equal(result.pending, 1)
  assert.equal(world.calls.some((c) => c.method === "POST" && c.url.endsWith(`/channels/${CHANNELS.tareas}/threads`)), false)
})

test("si no se puede editar el mensaje del post, se reintenta en la siguiente pasada", async () => {
  const id = "300000000000000012"
  const stored = JSON.stringify({ version: 1, since: "2026-10-21T00:00:00.000Z", items: { "12": synced({ thread: id, status: "En curso", area: undefined, assignees: ["jimy-k4"], milestone: undefined }) } })
  const world = fakeWorld([{ id, name: "#12 · P0 - Pipeline", parent_id: CHANNELS.tareas, applied_tags: ["t-curso"], owner_id: "999" }], { stored, failPatch: /\/messages\// })
  await withFetch(world.fetchMock, () => syncTasks(env, new Date("2026-12-31T00:00:00Z")))
  // Se guarda el mensaje antiguo: la próxima pasada vuelve a intentarlo
  assert.equal(world.state().items["12"].content, JSON.parse(stored).items["12"].content)
})
