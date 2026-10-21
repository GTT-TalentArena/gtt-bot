// /experimento: deja constancia en 🔬 experimentos, también de los que fallan.

import { BASELINE, BRAND, CHANNELS, GUILD_ID, type Split } from "./config.ts"
import { api, type Embed, type Env, type Message } from "./discord.ts"

export interface Experiment {
  titulo: string
  hipotesis: string
  resultado: string
  spellf1?: number
  macrof1?: number
  split?: string
  enlace?: string
  notas?: string
}

const RESULT: Record<string, { icon: string; color: number }> = {
  success: { icon: "✅", color: BRAND.ok },
  failure: { icon: "❌", color: BRAND.grana },
  mixed: { icon: "🟡", color: 0xf1c40f },
  open: { icon: "🔵", color: BRAND.blau },
}

// Compara solo contra el baseline del mismo split: 0,2433 (partido) y 0,3256 (5 min) no son comparables
export function vsBaseline(spellf1: number, split: string | undefined): string {
  if (!split || !(split in BASELINE)) return `**${spellf1.toFixed(4)}** (indica el split para compararlo con el baseline)`
  const base = BASELINE[split as Split]
  const delta = spellf1 - base
  const sign = delta >= 0 ? "+" : "−"
  return `**${spellf1.toFixed(4)}** · ${sign}${Math.abs(delta).toFixed(4)} vs baseline smooth50 (${base}, ${split})`
}

// Solo URLs http(s) válidas van al enlace del título; lo demás se muestra como texto
export function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

export function experimentEmbed(e: Experiment, author: string): Embed {
  const r = RESULT[e.resultado] ?? RESULT.open
  const url = safeUrl(e.enlace)
  const fields: Embed["fields"] = [{ name: "Hipótesis", value: e.hipotesis }]
  if (e.enlace && !url) fields.push({ name: "Enlace", value: e.enlace })
  if (e.spellf1 !== undefined) fields.push({ name: "spellF1", value: vsBaseline(e.spellf1, e.split), inline: false })
  if (e.macrof1 !== undefined) fields.push({ name: "macroF1", value: e.macrof1.toFixed(4), inline: true })
  if (e.split) fields.push({ name: "Split", value: e.split, inline: true })
  if (e.notas) fields.push({ name: "Aprendido / siguiente", value: e.notas })
  if (e.split === "public-5min") {
    fields.push({ name: "⚠️ Ojo", value: "La ventana pública sirve para validar el formato, no para elegir modelo." })
  }
  return {
    title: `${r.icon} ${e.titulo}`,
    url,
    color: r.color,
    description: `Resultado: **${e.resultado}** · por <@${author}>`,
    fields,
    footer: { text: "¿Va al log? PR en el fork con la etiqueta «log» y la cabecera en la descripción" },
    timestamp: new Date().toISOString(),
  }
}

export async function postExperiment(env: Env, e: Experiment, author: string): Promise<Message> {
  const msg = await api<{ id: string }>(env, "POST", `/channels/${CHANNELS.experimentos}/messages`, {
    embeds: [experimentEmbed(e, author)],
    allowed_mentions: { parse: [] },
  })
  const link = `https://discord.com/channels/${GUILD_ID}/${CHANNELS.experimentos}/${msg.id}`
  return { content: `🔬 Experimento registrado: ${link}`, flags: 64 }
}
