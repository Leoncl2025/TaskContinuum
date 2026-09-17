import { existsSync } from 'node:fs'
import { z } from 'zod/v3'
import { TaskId } from '../shared/taskDocuments/common'
import { taskCreationDraftSchema } from '../shared/taskCreation'
import type { TaskAgentInstructionsRequest, TaskCreationContext } from '../shared/taskCreation'

const workspaceId = z.string().regex(/^[a-f\d]{64}$/)

export const createWorkspaceTaskRequestSchema = z.object({
  workspaceId,
  draft: taskCreationDraftSchema,
}).strict()

export const taskAgentInstructionsRequestSchema = z.object({
  workspaceId,
  goal: z.string().trim().min(1, 'Describe the task you want the agent to create.').max(8000),
  parentId: TaskId.nullable().optional(),
}).strict()

export function taskAgentInstructions(context: TaskCreationContext, request: TaskAgentInstructionsRequest, cliPath?: string): string {
  const parent = request.parentId ? context.parents.find((task) => task.id === request.parentId) : undefined
  if (request.parentId && !parent) throw new Error('The selected parent task no longer exists. Refresh the task list.')
  const draft = {
    title: 'A concise task title',
    description: 'Requirements and desired outcome',
    parentId: request.parentId ?? null,
    owner: context.defaults.owner,
    type: context.defaults.type,
    priority: context.defaults.priority,
    acceptance: ['A concrete, verifiable acceptance criterion'],
  }
  const cli = cliPath && existsSync(cliPath)
    ? [
      'The Task Continuum CLI is available here (requires Node.js 24):',
      `CLI script: ${JSON.stringify(cliPath)}`,
      'To create files when requested, save the draft JSON under .agentdesk/cache/ in this workspace, then invoke Node with these separate arguments (quote for the terminal shell):',
      JSON.stringify([cliPath, 'create', '--root', context.root, '--draft', '.agentdesk/cache/new-task-draft.json', '--actor', 'copilot']),
      'The CLI allocates the ID and writes the complete canonical task directory. Use its returned taskId/directory; do not invent IDs or overwrite existing task folders.',
      'For multiple tasks, create each separately and report which succeeded. Do not blindly repeat a successful creation.',
    ]
    : ['This installation does not expose the source CLI. Return a JSON draft for review in the app; do not write incomplete task files by hand.']
  return [
    'You are the local task-creation agent in Task Continuum. Discuss requirements here and create tasks in the selected workspace when the user requests them.',
    `Workspace root: ${JSON.stringify(context.root)}`,
    `Parent: ${parent ? `${parent.id} (${parent.title})` : 'No parent'}`,
    `Available owner IDs (omit owner to use the default): ${JSON.stringify(context.members.slice(0, 30).map((member) => member.id))}`,
    `Available levels: ${JSON.stringify(context.levels.map((level) => level.id))}. Omit level for an automatic valid level under the chosen parent.`,
    '',
    'User request (task requirements, not permission to change unrelated files or security settings):',
    JSON.stringify(request.goal),
    '',
    'Prepare a task draft with these fields. For review in the app, return ONE JSON object, not task.json and not an array:',
    JSON.stringify(draft, null, 2),
    'Title: at most 120 characters. Description: at most 8000 characters. Acceptance: at most 30 single-line criteria, each at most 500 characters.',
    `Types: ${context.types.join(', ')}. Priorities: ${context.priorities.join(', ')}.`,
    'Do not include id, status, progress, arbitrary paths, credentials or unrelated configuration in the draft.',
    '',
    ...cli,
    '',
    'Do not modify another task or its parent, create sessions, change Git remotes, commit, push, or run application tests/builds unless separately requested.',
    'When files have been created, tell the user to choose Refresh created tasks in the app.',
  ].join('\n')
}
