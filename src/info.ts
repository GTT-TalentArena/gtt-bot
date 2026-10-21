// Información: cuenta atrás, chuleta del reto, GitHub (PRs y deploys) y log de la web.

import { BRAND, DEADLINE, ORG, REPOS, SITE } from "./config.ts"
import { type Embed, type Env, fit } from "./discord.ts"

const DAY = 86_400_000

export function countdown(now = new Date()): string {
  const ms = new Date(DEADLINE).getTime() - now.getTime()
  if (ms <= 0) return "🏁 La Phase 1 ya está entregada (deadline: 17-nov-2026)."
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / 3_600_000)
  if (days === 0) return `🔥 **Hoy es el día**: quedan **${hours} h** para la entrega (17-nov, 23:59).`
  return `⏳ Quedan **${days} días y ${hours} h** para la entrega de la Phase 1 (17-nov, 23:59).`
}

// Resumen de README.md del proyecto: si cambia el reto, actualizar aquí
const RETO: Record<string, Embed> = {
  metrica: {
    title: "📏 Métrica: spellF1 (desempate macroF1)",
    description: [
      "• **Spell** = tramo continuo de `H` o `A`; los `D` no cuentan y separan posesiones.",
      "• Se emparejan spells GT↔predichos del mismo equipo por **IoU temporal** (uno a uno) y se promedia el F1 a IoU **0,3–0,7**.",
      "• `X` se rellena con la última etiqueta: gratis dentro de una posesión, caro en un cambio.",
      "• Partir una posesión en dos (parpadeo) = 1 FN + 2 FP. Retraso de 1 s ≈ 0,65.",
      "• Baseline `smooth50`: **0,2433** partido completo · **0,3256** ventana pública. No los mezcles.",
      "• `python evaluation/run_evaluation.py --bootstrap 1000` antes de creerte una mejora < 0,04.",
    ].join("\n"),
  },
  datos: {
    title: "🗂️ Datos (FC Barcelona – Athletic Club)",
    description: [
      "• Vídeo **táctico** = referencia: **199.319 frames**, 25 fps. Fila *i* de la entrega = frame *i*.",
      "• Tracking ATD: coordenadas 0–1 (campo 105,3 × 68 m), **sin identidades**, `frame_id` = frame + 1.",
      "• Balón ausente en el **41 %** de los frames puntuados.",
      "• Puntúan 11.185–90.651 y 110.808–190.197 (ojo: el saque de la 2ª parte es en 113.742).",
      "• GT público: 11.185–18.684 (5 min, 17 posesiones). Solo para validar el formato.",
      "• Smart Tagging: 638 fases (no es GT). Homografía: campo 0–1 → píxeles.",
    ].join("\n"),
  },
  entrega: {
    title: "📦 Entrega (Google Form, antes del 17-nov)",
    description: [
      "1. `<team_name>.csv`: cabecera `frame,label`, **199.319 filas**, etiquetas `H/A/D/X`, sin vacíos.",
      "2. URL del **repo público** que regenera *exactamente* ese CSV con un comando.",
      "3. Documento técnico corto (`.pdf`/`.md`): enfoque, assets, reglas de posesión, uso de `X`, limitaciones.",
      "• Valida siempre el fichero final: `python evaluation/validate_submission.py <file>.csv`.",
      "• Sin leaderboard ni feedback: cuenta la última respuesta antes del deadline.",
    ].join("\n"),
  },
  reglas: {
    title: "⚖️ Reglas que no se negocian",
    description: [
      "• ❌ Etiquetar a mano la entrega o usar GT privado / posesión corregida de este partido.",
      "• ❌ Commitear o publicar datos del partido o derivados reconstruibles.",
      "• ❌ Subir vídeo, datasets o extractos a **LLMs en la nube**: solo código y métricas agregadas.",
      "• ✅ Cualquier método, modelo o dato externo explicado en el documento; pocos datos etiquetados a mano solo para entrenar o validar.",
      "• Equipos de 3 a 5. Dudas: issue en el repo oficial.",
    ].join("\n"),
  },
  enlaces: {
    title: "🔗 Enlaces",
    description: [
      `• Repo (fork): https://github.com/${ORG}/more-than-a-hack-2027`,
      `• Guía: https://github.com/${ORG}/more-than-a-hack-2027/blob/main/docs/GUIA_PROYECTO.md`,
      `• Web: ${SITE} · Log: ${SITE}/log/`,
      "• Oficial: https://github.com/metrica-sports/more-than-a-hack-2027",
      "• Reto: https://landing.mobileworldcapital.com/more-than-a-hack-2027",
    ].join("\n"),
  },
}

export function reto(tema: string): Embed {
  return { color: BRAND.blau, ...(RETO[tema] ?? RETO.enlaces) }
}

async function github<T>(env: Env, path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "gtt-discord-bot" }
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (res.status === 403 || res.status === 429) throw new GitHubLimitError()
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`)
  return (await res.json()) as T
}

// Sin GITHUB_TOKEN, el límite (60/h) es por IP y Cloudflare comparte IPs: se agota con facilidad
export class GitHubLimitError extends Error {
  constructor() {
    super("límite de la API de GitHub alcanzado (configura GITHUB_TOKEN)")
  }
}

export async function openPRs(env: Env): Promise<string[]> {
  const lists = await Promise.all(
    REPOS.map((repo) =>
      github<{ number: number; title: string; html_url: string; draft: boolean; user: { login: string } }[]>(
        env,
        `/repos/${ORG}/${repo}/pulls?state=open&per_page=10`,
      ).then((prs) =>
        prs.map((p) => `${p.draft ? "📝" : "🔀"} [${repo.split(".")[0]}#${p.number}](${p.html_url}) ${fit(p.title, 60)} · ${p.user.login}`),
      ),
    ),
  )
  return lists.flat()
}

export function ago(iso: string, now = new Date()): string {
  const min = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (min < 60) return `hace ${min} min`
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`
  return `hace ${Math.round(min / 1440)} días`
}

export async function lastDeploy(env: Env): Promise<string> {
  const { workflow_runs } = await github<{ workflow_runs: { conclusion: string | null; status: string; html_url: string; updated_at: string }[] }>(
    env,
    `/repos/${ORG}/gtt-talentarena.github.io/actions/workflows/deploy.yml/runs?per_page=1`,
  )
  const run = workflow_runs[0]
  if (!run) return "sin deploys"
  const icon = run.status !== "completed" ? "⏳" : run.conclusion === "success" ? "✅" : "❌"
  return `${icon} [${run.conclusion ?? run.status}](${run.html_url}) ${ago(run.updated_at)} · ${SITE}`
}

export interface LogEntry {
  date: string
  slug: string
  title: string
  type?: string
  outcome?: string
}

// Front matter mínimo: solo lee claves de una línea (title, type, outcome)
export function parseFrontMatter(md: string): Record<string, string> {
  const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim()
  }
  return out
}

export async function logEntries(env: Env, n = 5): Promise<LogEntry[]> {
  const files = await github<{ name: string; download_url: string }[]>(env, `/repos/${ORG}/gtt-talentarena.github.io/contents/content/log`)
  const md = files
    .filter((f) => f.name.endsWith(".md") && !f.name.startsWith("_"))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, n)
  return Promise.all(
    md.map(async (f) => {
      const res = await fetch(f.download_url)
      const meta = res.ok ? parseFrontMatter(await res.text()) : {}
      const base = f.name.replace(/\.md$/, "")
      return {
        date: base.slice(0, 10),
        slug: base.slice(11),
        title: meta.title ?? base.slice(11),
        type: meta.type,
        outcome: meta.outcome,
      }
    }),
  )
}

const OUTCOME: Record<string, string> = { success: "✅", failure: "❌", mixed: "🟡", open: "🔵" }

export function logLine(e: LogEntry): string {
  const badge = e.outcome ? `${OUTCOME[e.outcome] ?? ""} ` : ""
  return `${badge}\`${e.date}\` [${e.title}](${SITE}/log/${e.slug}/)${e.type ? ` · *${e.type}*` : ""}`
}
