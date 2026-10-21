// Definición de los comandos /. scripts/register.ts la sube a Discord; si cambias algo aquí, vuelve a registrar.

import { AREA_TAGS, STATUS_TAGS } from "./config.ts"

const SUB = 1
const STRING = 3
const USER = 6
const NUMBER = 10

const choices = (list: readonly string[]) => list.map((v) => ({ name: v, value: v }))

export const COMMANDS = [
  {
    name: "tarea",
    description: "Gestiona las tareas del foro 📋 tareas",
    options: [
      {
        type: SUB,
        name: "crear",
        description: "Crea una tarea nueva (📥 To do)",
        options: [
          { type: STRING, name: "titulo", description: "Título corto y claro", required: true, max_length: 90 },
          { type: USER, name: "responsable", description: "Quién la lleva", required: true },
          { type: STRING, name: "area", description: "Área", required: true, choices: choices(AREA_TAGS) },
          { type: STRING, name: "detalle", description: "Qué significa «hecho», enlaces…", max_length: 1500 },
        ],
      },
      {
        type: SUB,
        name: "estado",
        description: "Cambia el estado de la tarea (úsalo dentro de su post)",
        options: [{ type: STRING, name: "estado", description: "Nuevo estado", required: true, choices: choices(STATUS_TAGS) }],
      },
      {
        type: SUB,
        name: "lista",
        description: "Lista las tareas abiertas",
        options: [
          { type: STRING, name: "estado", description: "Filtra por estado", choices: choices(STATUS_TAGS) },
          { type: USER, name: "responsable", description: "Filtra por responsable" },
        ],
      },
    ],
  },
  {
    name: "experimento",
    description: "Registra un experimento en 🔬 experimentos",
    options: [
      { type: STRING, name: "titulo", description: "Qué se ha probado", required: true, max_length: 120 },
      { type: STRING, name: "hipotesis", description: "Qué esperábamos y por qué", required: true, max_length: 1000 },
      {
        type: STRING,
        name: "resultado",
        description: "Cómo ha ido",
        required: true,
        choices: choices(["success", "failure", "mixed", "open"]),
      },
      { type: NUMBER, name: "spellf1", description: "spellF1 obtenido", min_value: 0, max_value: 1 },
      { type: STRING, name: "split", description: "Dónde se ha medido", choices: choices(["full-match", "public-5min"]) },
      { type: NUMBER, name: "macrof1", description: "macroF1 obtenido", min_value: 0, max_value: 1 },
      { type: STRING, name: "enlace", description: "URL del PR o commit del fork", max_length: 500 },
      { type: STRING, name: "notas", description: "Qué hemos aprendido / siguiente paso", max_length: 1000 },
    ],
  },
  {
    name: "archivo",
    description: "Descarga el archivo privado del servidor (rol GTT Team)",
    options: [{ type: SUB, name: "discord", description: "Genera el archivo completo de Discord" }],
  },
  { name: "resumen", description: "Estado del equipo: tareas, PRs, último deploy y log" },
  { name: "countdown", description: "Cuánto queda para la entrega de la Phase 1" },
  {
    name: "reto",
    description: "Chuleta del reto",
    options: [
      {
        type: STRING,
        name: "tema",
        description: "Qué quieres consultar",
        required: true,
        choices: choices(["metrica", "datos", "entrega", "reglas", "enlaces"]),
      },
    ],
  },
  { name: "log", description: "Últimas entradas del log de la web" },
]
