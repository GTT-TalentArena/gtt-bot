// Da de alta (o actualiza) los comandos / en el servidor de GTT. Lee las credenciales de .dev.vars:
//   npm run register
import { COMMANDS } from "../src/commands.ts"
import { GUILD_ID } from "../src/config.ts"

const app = process.env.DISCORD_APPLICATION_ID
const token = process.env.DISCORD_BOT_TOKEN
if (!app || !token) {
  console.error("Faltan DISCORD_APPLICATION_ID o DISCORD_BOT_TOKEN en .dev.vars")
  process.exit(1)
}

// Comandos de servidor (no globales): se actualizan al instante
const res = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${GUILD_ID}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
})
if (!res.ok) {
  console.error(`Error ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const saved = (await res.json()) as { name: string }[]
console.log(`✓ ${saved.length} comandos registrados: ${saved.map((c) => "/" + c.name).join(" ")}`)
