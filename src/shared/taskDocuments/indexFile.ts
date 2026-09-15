// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";
import {
  DependencyType,
  Driver,
  IsoDate,
  IsoDateTime,
  Issue,
  Level,
  LinkKind,
  MemberId,
  Priority,
  SprintId,
  Tag,
  TaskId,
  TaskStatus,
} from "./common.js";
import { CopilotHandoff, CopilotPhase, ContextScope, DocState } from "./common.js";

/**
 * .agentdesk/index.json —— 派生索引(DD-5)。
 * 可完全重建,因此不入库;UI 首屏只读它,不遍历 tasks/**。
 */

export const TaskSummary = z.object({
  id: TaskId,
  dir: z.string(),
  /** task.json 的内容哈希 —— UI 写回时带上它做乐观锁 */
  hash: z.string(),
  /** true = 在 archive/ 下。仍参与建图,默认不在看板与树上显示。 */
  archived: z.boolean().default(false),
  /** true = 这个任务带了 skill.md */
  hasSkill: z.boolean().default(false),
  title: z.string(),
  status: TaskStatus,
  priority: Priority,
  owner: MemberId,
  driver: Driver,
  sprint: SprintId.nullable(),
  tags: z.array(Tag),
  due: IsoDate.nullable(),
  percent: z.number().int().min(0).max(100),
  checklist: z.object({
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  lifecycle: z.record(DocState),
  relations: z.object({
    level: Level,
    parent: TaskId.nullable(),
    depth: z.number().int().nonnegative(),
    ancestors: z.array(TaskId),
    rootId: TaskId.nullable(),
    children: z.array(TaskId),
    descendantCount: z.number().int().nonnegative(),
    isLeaf: z.boolean(),
    dependsOn: z.array(TaskId),
    blocks: z.array(TaskId),
    blockedBy: z.array(TaskId),
    readyToStart: z.boolean(),
    onCriticalPath: z.boolean(),
    rollupPercent: z.number().int().min(0).max(100),
  }),
  today: z
    .object({
      date: IsoDate.nullable(),
      nextAction: z.string().nullable(),
    })
    .nullable(),
  copilot: z
    .object({
      handoff: CopilotHandoff,
      phase: CopilotPhase.nullable(),
      contextScope: ContextScope,
    })
    .nullable(),
  pinnedLinks: z
    .array(
      z.object({
        kind: LinkKind,
        title: z.string(),
        url: z.string(),
      }),
    )
    .default([]),
  milestoneNext: z
    .object({
      id: z.string(),
      title: z.string(),
      due: IsoDate.nullable(),
    })
    .nullable(),
  hasNewContext: z.boolean().default(false),
  healthy: z.boolean(),
  issues: z.array(Issue),
});

export const Graph = z.object({
  roots: z.array(TaskId),
  hierarchy: z.array(z.object({ parent: TaskId, child: TaskId })),
  dependencies: z.array(
    z.object({
      from: TaskId,
      to: TaskId,
      type: DependencyType,
      hard: z.boolean(),
      lag: z.number().int(),
    }),
  ),
  topoOrder: z.array(TaskId),
  criticalPath: z.array(TaskId),
  cycles: z.array(z.array(TaskId)),
  issues: z.array(Issue),
});

export const IndexStats = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(z.number().int().nonnegative()),
  byLevel: z.record(z.number().int().nonnegative()),
  overdue: z.number().int().nonnegative(),
  dueToday: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  readyToStart: z.number().int().nonnegative(),
  unhealthy: z.number().int().nonnegative(),
  /** 目录存在但 task.json 读不了/不合法,这些任务无法渲染成卡片 */
  unloadable: z.number().int().nonnegative(),
});

/** 无法加载的任务目录。它们不能变成卡片,但绝不能静默消失。 */
export const BrokenTask = z.object({
  id: z.string(),
  dir: z.string(),
  issues: z.array(Issue),
});

export const IndexFile = z.object({
  schemaVersion: z.string(),
  generatedAt: IsoDateTime,
  workspaceHash: z.string(),
  tasks: z.array(TaskSummary),
  /** 加载失败的任务目录 */
  broken: z.array(BrokenTask),
  /** 工作区级别的问题(config 坏了、tasks/ 不存在等) */
  issues: z.array(Issue),
  graph: Graph,
  stats: IndexStats,
});

export type IndexFile = z.infer<typeof IndexFile>;
export type TaskSummary = z.infer<typeof TaskSummary>;
export type BrokenTask = z.infer<typeof BrokenTask>;
export type Graph = z.infer<typeof Graph>;
