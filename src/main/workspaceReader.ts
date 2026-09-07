import { createHash } from 'node:crypto'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { toString } from 'mdast-util-to-string'
import { z } from 'zod'
import type { AcceptanceItem, TaskRecord } from '../shared/tasks'
import { taskStatuses } from '../shared/tasks'
import type { WorkspaceSnapshot } from '../shared/workspace'

const configSchema = z.object({
  schemaVersion: z.literal('1.0'),
  workspace: z.string().min(1).max(200),
  paths: z.object({ tasks: z.string().min(1).max(1000) }).default({ tasks: 'tasks' }),
})
const taskSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().regex(/^T-\d{4,}$/),
  title: z.string().min(1).max(500),
  type: z.string().min(1).max(60),
  status: z.enum(taskStatuses),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  owner: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  relations: z.object({ level: z.string(), parent: z.string().nullable().optional() }),
  today: z.object({ nextAction: z.string().nullable().optional() }).optional(),
  progress: z.object({ mode: z.enum(['checklist', 'manual', 'rollup']), percent: z.number().min(0).max(100), manualPercent: z.number().min(0).max(100).nullable().optional() }).optional(),
})
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])
const maximumFileBytes = 1024 * 1024
const maximumWorkspaceBytes = 16 * 1024 * 1024

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function containedPath(root: string, file: string): Promise<string> {
  if (!inside(root, resolve(file))) throw new Error('Workspace path escapes the selected folder.')
  const canonical = await realpath(file)
  if (!inside(root, canonical)) throw new Error('Workspace link escapes the selected folder.')
  return canonical
}

function documentData(text: string | null) {
  const tree = markdown.parse(text ?? '')
  const first = tree.children[0]
  const body = first?.type === 'yaml' ? (text ?? '').slice(first.position?.end.offset ?? 0).trimStart() : text
  const checklist: AcceptanceItem[] = []
  const requirements: string[] = []
  const goals: string[] = []
  const plan: string[] = []
  for (const node of tree.children) {
    if (node.type === 'table') {
      for (const row of node.children) {
        const id = row.children[0] ? toString(row.children[0]) : ''
        const value = row.children[1] ? toString(row.children[1]).trim() : ''
        if (/^FR-\d+$/.test(id) && value) requirements.push(value)
        if (/^G\d+$/.test(id) && value) goals.push(value)
      }
    }
    if (node.type !== 'list') continue
    for (const item of node.children) {
      const paragraph = item.children[0]
      if (paragraph?.type !== 'paragraph') continue
      const text = paragraph.children.filter((child) => child.type !== 'html').map((child) => toString(child)).join('').trim()
      if (node.ordered && text) plan.push(text)
      const identifier = paragraph.children[0]
      if (typeof item.checked !== 'boolean' || identifier?.type !== 'inlineCode' || !/^CL-\d{3}$/.test(identifier.value)) continue
      checklist.push({ id: identifier.value, title: text.slice(identifier.value.length).trim(), done: item.checked })
    }
  }
  return { body, checklist, requirements, goals, plan }
}

export async function readTaskWorkspace(folder: string): Promise<WorkspaceSnapshot> {
  if (!isAbsolute(folder)) throw new Error('Choose an absolute workspace folder.')
  const root = await realpath(folder)
  if (!(await stat(root)).isDirectory()) throw new Error('The workspace must be a folder.')
  const warnings: string[] = []
  let bytesRead = 0
  async function read(relativeFile: string): Promise<string> {
    const file = await containedPath(root, join(root, relativeFile))
    const handle = await open(file, 'r')
    try {
      const details = await handle.stat()
      if (!details.isFile() || details.size > maximumFileBytes) throw new Error(`${relativeFile} exceeds the 1 MB file limit or is not a file.`)
      if (bytesRead + details.size > maximumWorkspaceBytes) throw new Error('The workspace exceeds the 16 MB read limit.')
      const content = await handle.readFile()
      bytesRead += content.byteLength
      if (content.byteLength > maximumFileBytes || bytesRead > maximumWorkspaceBytes) throw new Error('Workspace data changed beyond the read limit. Refresh to retry.')
      return content.toString('utf8')
    } finally { await handle.close() }
  }
  let rawConfig: unknown
  try { rawConfig = JSON.parse(await read('.agentdesk/config.json')) } catch (error) {
    throw new Error(`Choose an AgentDesk workspace containing .agentdesk/config.json. ${error instanceof Error ? error.message : ''}`)
  }
  const parsedConfig = configSchema.safeParse(rawConfig)
  if (!parsedConfig.success) throw new Error('The selected folder has an invalid AgentDesk workspace configuration.')
  const config = parsedConfig.data
  if (isAbsolute(config.paths.tasks) || !inside(root, resolve(root, config.paths.tasks))) throw new Error('The configured tasks path must stay inside the workspace.')
  const tasksRoot = await containedPath(root, resolve(root, config.paths.tasks))
  const entries = (await readdir(tasksRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  if (entries.length > 1000) throw new Error('The workspace exceeds the 1,000 task limit.')
  const tasks: TaskRecord[] = []
  const ids = new Set<string>()
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = join(config.paths.tasks, entry.name)
    try {
      const canonical = await containedPath(root, join(root, directory))
      if (!(await stat(canonical)).isDirectory()) continue
      const parsed = taskSchema.safeParse(JSON.parse(await read(join(directory, 'task.json'))))
      if (!parsed.success) throw new Error('task.json has invalid or unsupported fields.')
      const task = parsed.data
      if (ids.has(task.id)) throw new Error(`Duplicate task ID ${task.id}.`)
      ids.add(task.id)
      async function document(file: string): Promise<string | null> {
        try { return await read(join(directory, file)) } catch (error) {
          warnings.push(`${entry.name}/${file}: ${error instanceof Error ? error.message : 'Cannot read document.'}`)
          return null
        }
      }
      const requirements = documentData(await document('RequirementAnalysis.md'))
      const plan = documentData(await document('Plan.md'))
      const checklist = documentData(await document('Checklist.md'))
      const seen = new Set<string>()
      const items = checklist.checklist.filter((item) => {
        if (seen.has(item.id)) { warnings.push(`${entry.name}: Duplicate acceptance ID ${item.id}.`); return false }
        seen.add(item.id)
        return true
      })
      tasks.push({
        id: task.id, title: task.title, kind: task.relations.level === 'epic' ? 'epic' : task.type,
        parentId: task.relations.parent ?? undefined, status: task.status, priority: task.priority,
        owner: task.owner ?? 'Unassigned', summary: task.summary ?? 'No summary recorded.',
        goal: requirements.goals.join('\n') || task.summary || 'No goal recorded.',
        nextAction: task.today?.nextAction ?? 'No next action recorded.',
        requirements: requirements.requirements, plan: plan.plan, checklist: items,
        progress: task.progress?.mode === 'manual' ? task.progress.manualPercent ?? task.progress.percent
          : task.progress?.mode === 'rollup' ? task.progress.percent : undefined,
        documents: { requirements: requirements.body, plan: plan.body, checklist: checklist.body },
      })
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : 'Cannot read task.'}`)
    }
  }
  return {
    id: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex'),
    name: basename(root), title: config.workspace, root, tasks, warnings, loadedAt: new Date().toISOString(),
  }
}