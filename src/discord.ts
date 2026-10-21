// Lo mínimo de la API de Discord: verificar firmas, llamar a la API y editar respuestas diferidas.

const API = "https://discord.com/api/v10"

export interface Env {
  DISCORD_PUBLIC_KEY: string
  DISCORD_APPLICATION_ID: string
  DISCORD_BOT_TOKEN: string
  GITHUB_TOKEN?: string // opcional: sube el límite de la API de GitHub
}

export const InteractionType = { PING: 1, COMMAND: 2 } as const
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED: 5 } as const
export const EPHEMERAL = 64

export interface Option {
  name: string
  type: number
  value?: string | number
  options?: Option[]
}

export interface Interaction {
  type: number
  token: string
  channel_id?: string
  channel?: { id: string; parent_id?: string; type: number }
  member?: { user: { id: string; username: string } }
  data?: { name: string; options?: Option[] }
}

export interface Embed {
  title?: string
  url?: string
  description?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

export interface Message {
  content?: string
  embeds?: Embed[]
  flags?: number
  allowed_mentions?: { parse?: string[]; users?: string[] }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// Discord firma cada petición con Ed25519: sin verificar, cualquiera podría hacerse pasar por Discord
export async function verifySignature(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body))
  } catch {
    return false
  }
}

export async function api<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

// Sustituye el «pensando…» de una respuesta diferida por el mensaje final.
// Si Discord lo rechaza (embed inválido, token caducado…), se registra y se intenta con un texto simple
export async function editOriginal(env: Env, token: string, message: Message): Promise<void> {
  const patch = (m: Message) =>
    fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    })
  const res = await patch(message)
  if (res.ok) return
  console.error(`editOriginal → ${res.status} ${await res.text()}`)
  await patch({ content: "⚠️ No he podido mostrar la respuesta. Revisa los logs (`npx wrangler tail`).", allowed_mentions: { parse: [] } })
}

// Límites de Discord: 1024 caracteres por valor de campo, 4096 por descripción
export function fit(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

// Junta líneas sin pasarse de max caracteres; si sobran, cierra con «…y N más»
export function clip(lines: string[], max = 1000): string {
  const out: string[] = []
  let size = 0
  for (const [i, line] of lines.entries()) {
    const rest = `…y ${lines.length - i} más`
    if (size + line.length + 1 > max - rest.length - 1) {
      out.push(rest)
      break
    }
    out.push(line)
    size += line.length + 1
  }
  return out.join("\n")
}

// Las opciones llegan anidadas (subcomando → opciones): las aplana a {nombre: valor}
export function readOptions(options: Option[] = []): { sub?: string; values: Record<string, string | number> } {
  const sub = options.find((o) => o.type === 1)
  const list = sub ? (sub.options ?? []) : options
  const values: Record<string, string | number> = {}
  for (const o of list) if (o.value !== undefined) values[o.name] = o.value
  return { sub: sub?.name, values }
}
