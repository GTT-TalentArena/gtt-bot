// Cliente mínimo del GitHub Project de tareas (GraphQL): leer items, cambiar Status/Área y crear issues.
// Necesita GITHUB_TOKEN con Issues (lectura y escritura) en el fork y Projects (lectura y escritura) en la org.

import { AREA_FIELD, AREA_TAGS, ORG, PROJECT, PROJECT_STATUS } from "./config.ts"
import type { Env } from "./discord.ts"

const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "gtt-discord-bot" }

interface SelectField {
  id: string
  name: string
  options: { id: string; name: string }[]
}

export interface ProjectMeta {
  id: string
  status: SelectField
  area?: SelectField
}

// Una issue del Project, con Status y Área ya traducidos a los nombres de las etiquetas del foro
export interface ProjectItem {
  itemId: string
  issueId: string
  number: number
  title: string
  url: string
  createdAt?: string
  assignees: string[]
  milestone?: string
  status?: string
  area?: string
}

function token(env: Env): string {
  if (!env.GITHUB_TOKEN) throw new Error("Falta GITHUB_TOKEN (PAT con Issues y Projects de escritura) en los secrets del Worker.")
  return env.GITHUB_TOKEN
}

export async function graphql<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`GitHub GraphQL → ${res.status} ${(await res.text()).slice(0, 300)}`)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length || !json.data) throw new Error(`GitHub GraphQL: ${json.errors?.map((e) => e.message).join("; ") ?? "sin datos"}`)
  return json.data
}

const PROJECT_QUERY = `query($org: String!, $number: Int!) {
  organization(login: $org) { projectV2(number: $number) { id
    fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
    items(first: 100) { nodes { id
      fieldValues(first: 30) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } }
      content { ... on Issue { id number title url createdAt repository { name } assignees(first: 10) { nodes { login } } milestone { title } } }
    } }
  } }
}`

interface RawProject {
  organization: {
    projectV2: {
      id: string
      fields: { nodes: Partial<SelectField>[] }
      items: {
        nodes: {
          id: string
          fieldValues: { nodes: { name?: string; field?: { name?: string } }[] }
          content: {
            id?: string
            number?: number
            title?: string
            url?: string
            createdAt?: string
            repository?: { name: string }
            assignees?: { nodes: { login: string }[] }
            milestone?: { title: string } | null
          } | null
        }[]
      }
    }
  }
}

// Separado de loadProject para probarlo sin red
export function parseProject(raw: RawProject): { meta: ProjectMeta; items: ProjectItem[] } {
  const project = raw.organization.projectV2
  const fields = project.fields.nodes.filter((f): f is SelectField => Boolean(f.id && f.name && f.options))
  const status = fields.find((f) => f.name === "Status")
  if (!status) throw new Error("El Project no tiene el campo Status")
  const area = fields.find((f) => f.name === AREA_FIELD)

  const items: ProjectItem[] = []
  for (const node of project.items.nodes) {
    const c = node.content
    // Solo issues del fork: las notas (draft) y PRs no tienen post en el foro
    if (!c?.id || c.number === undefined || c.repository?.name !== PROJECT.repo) continue
    const value = (field: string) => node.fieldValues.nodes.find((v) => v.field?.name === field)?.name
    const statusName = value("Status")
    const areaName = value(AREA_FIELD)
    items.push({
      itemId: node.id,
      issueId: c.id,
      number: c.number,
      title: c.title ?? "",
      url: c.url ?? "",
      createdAt: c.createdAt,
      assignees: (c.assignees?.nodes ?? []).map((a) => a.login),
      milestone: c.milestone?.title,
      status: statusName === undefined ? undefined : PROJECT_STATUS[statusName],
      area: AREA_TAGS.find((a) => a === areaName),
    })
  }
  return { meta: { id: project.id, status, area }, items }
}

export async function loadProject(env: Env): Promise<{ meta: ProjectMeta; items: ProjectItem[] }> {
  return parseProject(await graphql<RawProject>(env, PROJECT_QUERY, { org: ORG, number: PROJECT.number }))
}

// El campo Área no existe al principio: se crea una vez con las mismas opciones que las etiquetas del foro
export async function ensureAreaField(env: Env, meta: ProjectMeta): Promise<ProjectMeta> {
  if (meta.area) return meta
  const colors = ["BLUE", "PURPLE", "GRAY", "YELLOW"]
  const { createProjectV2Field } = await graphql<{ createProjectV2Field: { projectV2Field: SelectField } }>(
    env,
    `mutation($project: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: { projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }`,
    { project: meta.id, name: AREA_FIELD, options: AREA_TAGS.map((name, i) => ({ name, color: colors[i % colors.length], description: "" })) },
  )
  return { ...meta, area: createProjectV2Field.projectV2Field }
}

/** Pone Status o Área de un item (nombres del foro). Área undefined = vaciar el campo. */
export async function setItemField(env: Env, meta: ProjectMeta, itemId: string, field: "status" | "area", value: string | undefined): Promise<void> {
  const target = field === "status" ? meta.status : meta.area
  if (!target) throw new Error(`El Project no tiene el campo ${field === "status" ? "Status" : AREA_FIELD}`)
  if (value === undefined) {
    await graphql(env, `mutation($project: ID!, $item: ID!, $field: ID!) {
      clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } }
    }`, { project: meta.id, item: itemId, field: target.id })
    return
  }
  const optionName = field === "status" ? Object.keys(PROJECT_STATUS).find((k) => PROJECT_STATUS[k] === value) : value
  const option = target.options.find((o) => o.name === optionName)
  if (!option) throw new Error(`El campo ${target.name} no tiene la opción «${optionName ?? value}»`)
  await graphql(env, `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
  }`, { project: meta.id, item: itemId, field: target.id, option: option.id })
}

/** Crea la issue en el fork y la añade al Project. Devuelve el item ya listo para fijar sus campos. */
export async function createProjectIssue(
  env: Env,
  meta: ProjectMeta,
  v: { title: string; body: string; assignees: string[] },
): Promise<ProjectItem> {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${PROJECT.repo}/issues`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: v.title, body: v.body, assignees: v.assignees }),
  })
  if (!res.ok) throw new Error(`GitHub crear issue → ${res.status} ${(await res.text()).slice(0, 300)}`)
  const issue = (await res.json()) as { node_id: string; number: number; title: string; html_url: string; created_at: string; assignees: { login: string }[] }
  const { addProjectV2ItemById } = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    env,
    `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
    { project: meta.id, content: issue.node_id },
  )
  return {
    itemId: addProjectV2ItemById.item.id,
    issueId: issue.node_id,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    createdAt: issue.created_at,
    assignees: issue.assignees.map((a) => a.login),
  }
}
