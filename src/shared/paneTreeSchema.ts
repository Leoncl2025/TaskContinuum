import { z } from 'zod'

export const MAX_PERSISTED_PANE_GROUPS = 8
export const MAX_PANE_TREE_DEPTH = 8

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const nodeIdSchema = z.string().min(1).max(128)
const sessionKeySchema = z.string().startsWith('ahp:').max(2048)

const paneSessionsSchema = z.unknown().refine(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 1000
    && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success),
  'Invalid pane session map.',
).pipe(z.record(taskIdSchema, sessionKeySchema.nullable()))

export interface PersistedPaneGroup {
  readonly kind: 'group'
  readonly id: string
  readonly openTaskIds: readonly string[]
  readonly activeTaskId: string | null
  readonly sessions: Readonly<Record<string, string | null>>
}

export interface PersistedPaneSplit {
  readonly kind: 'split'
  readonly id: string
  readonly orientation: 'horizontal' | 'vertical'
  readonly ratio: number
  readonly first: PersistedPaneTreeNode
  readonly second: PersistedPaneTreeNode
}

export type PersistedPaneTreeNode = PersistedPaneGroup | PersistedPaneSplit

export interface PersistedPaneTreeState {
  readonly root: PersistedPaneTreeNode
  readonly activeGroupId: string
}

const paneGroupSchema: z.ZodType<PersistedPaneGroup> = z.object({
  kind: z.literal('group'),
  id: nodeIdSchema,
  openTaskIds: z.array(taskIdSchema).max(200).refine((ids) => new Set(ids).size === ids.length, 'Duplicate open tasks in pane.'),
  activeTaskId: taskIdSchema.nullable(),
  sessions: paneSessionsSchema,
}).strict().refine(
  (group) => group.activeTaskId === null ? group.openTaskIds.length === 0 : group.openTaskIds.includes(group.activeTaskId),
  'Active task must be open in pane.',
)

function buildNodeSchema(depth: number): z.ZodType<PersistedPaneTreeNode> {
  if (depth >= MAX_PANE_TREE_DEPTH) return paneGroupSchema
  const childSchema = z.lazy(() => buildNodeSchema(depth + 1))
  const splitSchema: z.ZodType<PersistedPaneSplit> = z.object({
    kind: z.literal('split'),
    id: nodeIdSchema,
    orientation: z.enum(['horizontal', 'vertical']),
    ratio: z.number().finite().min(0.2).max(0.8),
    first: childSchema,
    second: childSchema,
  }).strict()
  return z.union([paneGroupSchema, splitSchema])
}

const paneTreeNodeSchema = buildNodeSchema(0)

function inspectTreeIds(
  node: PersistedPaneTreeNode,
  groupIds: Set<string>,
  splitIds: Set<string>,
): boolean {
  if (node.kind === 'group') {
    if (groupIds.has(node.id)) return false
    groupIds.add(node.id)
    return groupIds.size <= MAX_PERSISTED_PANE_GROUPS
  }
  if (splitIds.has(node.id)) return false
  splitIds.add(node.id)
  return inspectTreeIds(node.first, groupIds, splitIds) && inspectTreeIds(node.second, groupIds, splitIds)
}

export const persistedPaneTreeSchema: z.ZodType<PersistedPaneTreeState> = z.object({
  root: paneTreeNodeSchema,
  activeGroupId: nodeIdSchema,
}).strict().refine((tree) => {
  const groupIds = new Set<string>()
  const splitIds = new Set<string>()
  if (!inspectTreeIds(tree.root, groupIds, splitIds)) return false
  return groupIds.size >= 1 && groupIds.size <= MAX_PERSISTED_PANE_GROUPS && groupIds.has(tree.activeGroupId)
}, 'Invalid pane tree structure or active group.')
