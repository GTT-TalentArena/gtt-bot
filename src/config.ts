// Datos fijos del servidor y del reto. Los IDs no son secretos: solo los tokens van en secrets.

export const GUILD_ID = "1562076469172117586"
// Solo este rol puede descargar el historial entero desde /archivo discord.
// No es una credencial; el Worker también comprueba que la interacción sea del guild.
export const ARCHIVE_ROLE_ID = "1562078825272057856" // ⚽ GTT Team

export const CHANNELS = {
  general: "1562076469679886440",
  tareas: "1562077480624324669", // foro
  experimentos: "1562077569443041440",
} as const

export const ORG = "GTT-TalentArena"
export const REPOS = ["more-than-a-hack-2027", "gtt-talentarena.github.io"] as const
export const SITE = "https://gtt-talentarena.github.io"

// Misma fecha que usa la web (lib/content.ts): la hora exacta no está publicada
export const DEADLINE = "2026-11-17T23:59:59+01:00"

// Etiquetas del foro de tareas: cada post lleva una de estado y una de área
export const STATUS_TAGS = ["To do", "En curso", "Review", "Bloqueado", "Hecho"] as const
export const AREA_TAGS = ["Datos", "Algoritmos", "Infra", "Pitch"] as const
// Las tareas viven en el GitHub Project (manda) y el foro es su espejo: ver src/sincronizar.ts
export const PROJECT = { number: 3, repo: "more-than-a-hack-2027" } as const
// Status del Project → etiqueta de estado del foro
export const PROJECT_STATUS: Record<string, (typeof STATUS_TAGS)[number]> = {
  Todo: "To do",
  "In Progress": "En curso",
  Review: "Review",
  Blocked: "Bloqueado",
  Done: "Hecho",
}
// Campo del Project con las mismas opciones que AREA_TAGS (el bot lo crea si falta)
export const AREA_FIELD = "Área"

// Equipo: GitHub ↔ Discord, para convertir asignados en menciones y al revés.
// Los IDs de Discord no son secretos (clic derecho en el usuario → Copiar ID). Vacío = sin mención.
export const TEAM: readonly { github: string; discord: string }[] = [
  { github: "AlejandroMolines", discord: "283326847662686209" },
  { github: "jimy-k4", discord: "350599420909322250" },
  { github: "hxst1", discord: "398174691027714059" },
  { github: "n1co2611", discord: "562647167890620418" },
  { github: "PabloCordoba3", discord: "453578252330598400" },
]

export const STATUS_EMOJI: Record<string, string> = {
  "To do": "📥",
  "En curso": "🚧",
  Review: "👀",
  Bloqueado: "⛔",
  Hecho: "✅",
}

// spellF1 de baseline_smooth50 (evaluation/results): no mezclar splits al comparar
export const BASELINE = {
  "full-match": 0.2433,
  "public-5min": 0.3256,
} as const
export type Split = keyof typeof BASELINE

export const BRAND = {
  grana: 0xa50044,
  blau: 0x1d3fc9,
  estadio: 0x0b0e2c,
  ok: 0x2ea043,
  gris: 0x95a5a6,
}
