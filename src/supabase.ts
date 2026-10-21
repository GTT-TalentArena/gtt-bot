// Cliente mínimo para el Storage privado de Supabase. Evita añadir un SDK y no
// construye URLs públicas: el secreto del Worker se manda solo a Supabase.

import type { Env } from "./discord.ts"

export const ARCHIVE_BUCKET = "discord-archives"

function settings(env: Env): { base: string; key: string } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Faltan SUPABASE_URL o SUPABASE_SECRET_KEY en los secrets del Worker.")
  let url: URL
  try { url = new URL(env.SUPABASE_URL) } catch { throw new Error("SUPABASE_URL no es una URL válida.") }
  if (url.protocol !== "https:") throw new Error("SUPABASE_URL debe usar HTTPS.")
  return { base: url.origin, key: env.SUPABASE_SECRET_KEY }
}

function objectUrl(base: string, path: string, authenticated = false, cacheBust?: string): string {
  // Cada segmento se codifica por separado: ni el nombre del objeto ni un estado
  // corrupto pueden convertir una ruta de Storage en otra URL.
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  const url = new URL(`/storage/v1/object/${authenticated ? "authenticated/" : ""}${encodeURIComponent(ARCHIVE_BUCKET)}/${encoded}`, base)
  if (cacheBust) url.searchParams.set("cache", cacheBust)
  return url.href
}

function headers(key: string, extra: HeadersInit = {}): Headers {
  const out = new Headers(extra)
  out.set("apikey", key)
  out.set("Authorization", `Bearer ${key}`)
  return out
}

async function failure(response: Response, operation: string, path: string): Promise<Error> {
  const detail = (await response.text()).slice(0, 500)
  return new Error(`Supabase Storage ${operation} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`)
}

/** Lee un objeto de un bucket no público; 404 es útil para la primera sincronización. */
export async function getPrivateObject(env: Env, path: string, cacheBust = String(Date.now())): Promise<Response | undefined> {
  const { base, key } = settings(env)
  const response = await fetch(objectUrl(base, path, true, cacheBust), { headers: headers(key) })
  if (response.status === 404) return undefined
  if (!response.ok) throw await failure(response, "GET", path)
  return response
}

export async function getPrivateText(env: Env, path: string): Promise<string | undefined> {
  const response = await getPrivateObject(env, path)
  return response && response.text()
}

/**
 * POST /storage/v1/object usa el endpoint de carga estándar de Supabase. El
 * archivo usa x-upsert para sustituir su único objeto privado actual.
 */
export async function putPrivateObject(env: Env, path: string, content: string, contentType: string, upsert = false): Promise<void> {
  const { base, key } = settings(env)
  const response = await fetch(objectUrl(base, path), {
    method: "POST",
    headers: headers(key, {
      "Content-Type": contentType,
      "Cache-Control": upsert ? "no-store" : "private, max-age=31536000, immutable",
      ...(upsert ? { "x-upsert": "true" } : {}),
    }),
    body: content,
  })
  if (!response.ok) throw await failure(response, "POST", path)
}

