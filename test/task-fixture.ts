import type { TaskRecord } from '../src/shared/tasks'

export const fixtureTasks: TaskRecord[] = [
  {
    id: 'T-0001', title: 'Task Continuum MVP', kind: 'epic', status: 'in-progress', priority: 'P1', owner: 'You',
    summary: 'Keep meaningful work moving across tasks, sessions, and people.',
    goal: 'A focused home for your tasks, the conversations behind them, and a clear next step.',
    nextAction: 'Validate the task-to-conversation workflow with the desktop prototype.',
    requirements: ['A durable task is the anchor for every conversation.', 'Keep decisions and acceptance criteria visible.', 'Separate UI, agent execution, and storage concerns.'],
    plan: ['Build a focused desktop workbench.', 'Introduce a Session Host behind a typed adapter.', 'Verify a complete task handoff before adding collaboration.'],
    checklist: [
      { id: 'CL-001', title: 'Define the task and session model', done: true },
      { id: 'CL-002', title: 'Validate the desktop workflow', done: false },
      { id: 'CL-003', title: 'Connect a real Session Host', done: false },
    ],
  },
  {
    id: 'T-0002', title: 'UI based on Electron', kind: 'feature', parentId: 'T-0001', status: 'in-progress', priority: 'P2', owner: 'You',
    summary: 'A familiar workspace. Just the tools you need to move a task forward.',
    goal: 'Build a lightweight, VS Code-inspired desktop workbench with task navigation, a dedicated viewer, and contextual chat — without the weight of a full IDE.',
    nextAction: 'Explore a task, review its checklist, and start a conversation alongside it.',
    requirements: ['Browse and filter tasks without losing your place.', 'Keep requirements, plans, and acceptance in one viewer.', 'Scope conversations and drafts to the selected task.', 'Collapse panels and navigate with the keyboard.'],
    plan: ['Choose small, reusable open-source building blocks.', 'Isolate Electron main, preload, and renderer processes.', 'Build the task explorer and document viewer.', 'Verify chat isolation, cancellation, and compact layouts.'],
    checklist: [
      { id: 'CL-001', title: 'Select the lightweight UI foundation', done: true },
      { id: 'CL-002', title: 'Define the secure Electron boundary', done: true },
      { id: 'CL-003', title: 'Build the task explorer and viewer', done: false },
      { id: 'CL-004', title: 'Verify task-scoped conversations', done: false },
      { id: 'CL-005', title: 'Complete desktop and keyboard checks', done: false },
    ],
  },
  {
    id: 'T-0003', title: 'Backend service', kind: 'feature', parentId: 'T-0001', status: 'backlog', priority: 'P1', owner: 'You',
    summary: 'Give sessions an independent home beyond the desktop window.',
    goal: 'Introduce a local Session Host that owns durable conversation history and coordinates agent requests.',
    nextAction: 'Define the session event contract and persistence boundaries.',
    requirements: ['Keep execution independent of the UI lifecycle.', 'Identify every request and event for reliable replay.', 'Gate reads, messages, and approvals separately.'],
    plan: ['Define versioned session events.', 'Persist history and requests locally.', 'Connect one Agent Harness through an adapter.'],
    checklist: [
      { id: 'CL-001', title: 'Review the Session Host contract', done: false },
      { id: 'CL-002', title: 'Verify history replay and request deduplication', done: false },
    ],
  },
  {
    id: 'T-0004', title: 'Technical design', kind: 'spike', parentId: 'T-0001', status: 'backlog', priority: 'P2', owner: 'You',
    summary: 'Make the boundaries explicit before connecting the pieces.',
    goal: 'Describe how the UI, Session Host, Agent Harness, and storage fit together.',
    nextAction: 'Review the communication and identity boundaries with the team.',
    requirements: ['Separate transport from session authorization.', 'Keep large artifacts outside live databases.', 'Document unsupported provider capabilities.'],
    plan: ['Sketch component responsibilities.', 'Review the SSH collaboration path.', 'Capture implementation decisions and trade-offs.'],
    checklist: [
      { id: 'CL-001', title: 'Sketch the component architecture', done: false },
      { id: 'CL-002', title: 'Review multi-machine communication', done: false },
    ],
  },
  {
    id: 'T-0005', title: 'Map the first user journey', kind: 'spike', parentId: 'T-0001', status: 'done', priority: 'P3', owner: 'You',
    summary: 'From finding a task to knowing what to do next.',
    goal: 'Make task navigation, context review, and a first conversation feel like one continuous workflow.',
    nextAction: 'Use this journey as a baseline for usability checks.',
    requirements: ['Tasks are easy to find.', 'The next action is visible.', 'Chat never loses its task context.'],
    plan: ['Map the essential steps.', 'Remove unrelated IDE features.', 'Review the first-use experience.'],
    checklist: [
      { id: 'CL-001', title: 'Map the primary journey', done: true },
      { id: 'CL-002', title: 'Review the minimum interface', done: true },
    ],
  },
]