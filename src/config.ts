// Datos fijos del servidor y del reto. Los IDs no son secretos: solo los tokens van en secrets.

export const GUILD_ID = "1562076469172117586"

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
