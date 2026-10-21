// Entrada de GitHub Actions (y de ejecución local con variables de entorno).
// No imprime credenciales ni crea ficheros locales con conversaciones.
import { syncDiscordArchive } from "../src/archivo.ts"
import type { Env } from "../src/discord.ts"

function required(name: "DISCORD_BOT_TOKEN" | "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta ${name}. Configúralo como secret de GitHub Actions o variable local.`)
  return value
}

const env: Env = {
  // Este proceso no atiende interacciones; estos dos valores no se usan aquí.
  DISCORD_APPLICATION_ID: "",
  DISCORD_PUBLIC_KEY: "",
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: required("SUPABASE_SECRET_KEY"),
}

const result = await syncDiscordArchive(env)
console.log(`[archivo] ${result.created ? "copia inicial" : result.saved ? "actualizado" : "sin cambios"}; +${result.added} mensajes; ${result.archive.archive.length} canales/hilos; ${result.archive.omissions.length ? `parcial (${result.archive.omissions.length} omisiones)` : "completo"}.`)
