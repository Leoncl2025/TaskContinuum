// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";
import {
  ContextScope,
  CopilotHandoff,
  CopilotPhase,
  DependencyType,
  DocState,
  Driver,
  IsoDate,
  IsoDateTime,
  Issue,
  JobId,
  Level,
  MemberId,
  Note,
  Priority,
  ProgressMode,
  Size,
  Slug,
  SourceId,
  SprintId,
  SyncSourceKind,
  Tag,
  TaskId,
  TaskStatus,
  TaskType,
  LinkId,
} from "./common.js";

// ---------------------------------------------------------------------------
// relations —— 从属(树)与依赖(DAG),见 Design §7
//
// 只写一个方向(DD-9):
//   • 子任务写 parent            → 父的 children 是派生值
//   • 后继任务写 dependsOn       → 前驱的 blocks / blockedBy 是派生值
// ---------------------------------------------------------------------------

export const Dependency = z.object({
  /** 前驱任务。 */
  id: TaskId,
  type: DependencyType.default("finish-to-start"),
  /** true = 未满足则进入 blockedBy;false = 仅提示。 */
  hard: z.boolean().default(true),
  /** 缓冲天数,可为负。 */
  lag: z.number().int().default(0),
  note: Note.optional(),
});

export const Relations = z.object({
  level: Level,
  /** 唯一父节点。children 为派生值,禁止在此手写。 */
  parent: TaskId.nullable().default(null),
  /** 只写"我依赖谁"。blocks / blockedBy 为派生值。 */
  dependsOn: z.array(Dependency).default([]),
  /** 弱关联:只做互相跳转,不参与阻塞与排期。 */
  relatedTo: z.array(TaskId).default([]),
  duplicateOf: TaskId.nullable().default(null),
});

// ---------------------------------------------------------------------------
// 生命周期文档状态
//
// 只记录"推进状态",不记录路径 —— 路径由约定固定:
//   RequirementAnalysis.md / Plan.md / designs/ / Checklist.md / Reference.md / ref/
// 记路径等于把同一信息写两遍,违反单一所有者原则(§3.1)。
// ---------------------------------------------------------------------------

export const LifecycleEntry = z.object({
  state: DocState,
  updated: IsoDate.optional(),
});

export const Lifecycle = z.object({
  requirement: LifecycleEntry,
  plan: LifecycleEntry,
  design: LifecycleEntry,
  checklist: LifecycleEntry,
  reference: LifecycleEntry,
});

/** 生命周期键 → 对应文件(或目录)的约定路径。 */
export const LIFECYCLE_PATHS = {
  requirement: "RequirementAnalysis.md",
  plan: "Plan.md",
  design: "designs",
  checklist: "Checklist.md",
  reference: "Reference.md",
} as const satisfies Record<keyof z.infer<typeof Lifecycle>, string>;

// ---------------------------------------------------------------------------
// 其余分组
// ---------------------------------------------------------------------------

export const Dates = z.object({
  created: IsoDate,
  started: IsoDate.nullable().default(null),
  due: IsoDate.nullable().default(null),
  completed: IsoDate.nullable().default(null),
});

export const Effort = z.object({
  estimateHours: z.number().nonnegative().nullable().default(null),
  spentHours: z.number().nonnegative().default(0),
});

export const Progress = z.object({
  /** checklist(叶子默认) | rollup(有子任务时默认) | manual */
  mode: ProgressMode.default("checklist"),
  /** mode ≠ manual 时为派生值,由索引器覆写。 */
  percent: z.number().int().min(0).max(100).default(0),
  manualPercent: z.number().int().min(0).max(100).nullable().default(null),
  /** rollup 时,自身 Checklist 是否作为一个虚拟子节点参与加权。 */
  rollupIncludeSelf: z.boolean().default(true),
});

export const Today = z.object({
  date: IsoDate.nullable().default(null),
  focus: z.string().max(200).nullable().default(null),
  nextAction: z.string().max(200).nullable().default(null),
  timeboxHours: z.number().positive().max(24).nullable().default(null),
});

export const CopilotConfig = z.object({
  handoff: CopilotHandoff.default("none"),
  phase: CopilotPhase.nullable().default(null),
  contextScope: ContextScope.default("ancestors"),
  /** 入口文档,可带锚点,例如 Plan.md#M2 */
  entryDoc: z.string().max(120).nullable().default(null),
  instructions: z.string().max(2000).nullable().default(null),
  /**
   * 边界声明。注意:这是**引导**不是安全边界 —— Copilot 的原生文件工具无法剥夺,
   * 真正的强制发生在落地闸门 G1–G6(Design §12.9 / DD-18)。
   */
  allowedPaths: z.array(z.string()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  lastRunAt: IsoDateTime.nullable().default(null),
  lastRunCommit: z.string().max(40).nullable().default(null),
});

export const SyncSource = z.object({
  id: SourceId,
  kind: SyncSourceKind,
  /** 指向 Reference.md front matter 里的链接 id —— 复用链接的所有权,不重复定义 URL。 */
  ref: LinkId,
  /** 水位。只有人工接受同步后才由 server 推进(DD-15)。 */
  cursor: z.string().max(120).nullable().default(null),
  enabled: z.boolean().default(true),
});

export const Sync = z.object({
  lastRunAt: IsoDateTime.nullable().default(null),
  lastJobId: JobId.nullable().default(null),
  autoOnOpen: z.boolean().default(false),
  sources: z.array(SyncSource).default([]),
});

export const HistoryEntry = z.object({
  at: IsoDateTime,
  by: MemberId,
  field: z.string().max(60),
  from: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  note: Note.optional(),
});

// ---------------------------------------------------------------------------
// derived —— 由 indexer 生成,禁止手改
// ---------------------------------------------------------------------------

export const DerivedRelations = z.object({
  children: z.array(TaskId).default([]),
  childCount: z.number().int().nonnegative().default(0),
  descendantCount: z.number().int().nonnegative().default(0),
  depth: z.number().int().nonnegative().default(0),
  ancestors: z.array(TaskId).default([]),
  rootId: TaskId.nullable().default(null),
  isLeaf: z.boolean().default(true),
  blocks: z.array(TaskId).default([]),
  blockedBy: z.array(TaskId).default([]),
  readyToStart: z.boolean().default(true),
  earliestStart: IsoDate.nullable().default(null),
  rolledDue: IsoDate.nullable().default(null),
  rollupPercent: z.number().int().min(0).max(100).default(0),
  onCriticalPath: z.boolean().default(false),
});

export const Suggestion = z.object({
  field: z.string().max(60),
  from: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  reason: z.string().max(200),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

export const Derived = z.object({
  checklist: z
    .object({
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .default({ passed: 0, total: 0 }),
  designs: z
    .object({
      count: z.number().int().nonnegative(),
      active: z.string().nullable(),
      byState: z.record(z.number().int().nonnegative()),
    })
    .optional(),
  refFileCount: z.number().int().nonnegative().default(0),
  linkCount: z.number().int().nonnegative().default(0),
  milestoneNext: z.string().nullable().default(null),
  relations: DerivedRelations.optional(),
  sync: z
    .object({
      hasNewContext: z.boolean().default(false),
      lastSyncAt: IsoDateTime.nullable().default(null),
      pendingJobId: JobId.nullable().default(null),
      gateBlocked: z.boolean().default(false),
    })
    .optional(),
  mentions: z.array(TaskId).default([]),
  suggestions: z.array(Suggestion).default([]),
  healthy: z.boolean().default(true),
  issues: z.array(Issue).default([]),
});

// ---------------------------------------------------------------------------
// task.json
// ---------------------------------------------------------------------------

export const Task = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.string(),

    id: TaskId,
    slug: Slug,
    title: z.string().min(1).max(120),
    summary: z.string().max(500).nullable().default(null),

    type: TaskType,
    status: TaskStatus,
    priority: Priority,
    size: Size.nullable().default(null),
    sprint: SprintId.nullable().default(null),

    owner: MemberId,
    assignees: z.array(MemberId).default([]),
    driver: Driver.default("human"),
    tags: z.array(Tag).default([]),

    relations: Relations,
    dates: Dates,
    effort: Effort.default({ estimateHours: null, spentHours: 0 }),
    lifecycle: Lifecycle,
    progress: Progress,
    today: Today.optional(),
    copilot: CopilotConfig.optional(),
    sync: Sync.optional(),

    /** 由 indexer 覆写,手写内容会被丢弃。 */
    derived: Derived.optional(),

    /** 只追加,不改写。 */
    history: z.array(HistoryEntry).default([]),
  })
  .superRefine((task, ctx) => {
    if (task.relations.parent === task.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relations", "parent"],
        message: `${task.id} cannot be its own parent`,
      });
    }
    for (const [i, dep] of task.relations.dependsOn.entries()) {
      if (dep.id === task.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relations", "dependsOn", i, "id"],
          message: `${task.id} cannot depend on itself`,
        });
      }
    }
    const depIds = task.relations.dependsOn.map((d) => d.id);
    if (new Set(depIds).size !== depIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relations", "dependsOn"],
        message: `${task.id} has duplicate entries in dependsOn`,
      });
    }
    if (task.status === "done" && !task.dates.completed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dates", "completed"],
        message: `dates.completed is required when status is done`,
      });
    }
    if (task.progress.mode === "manual" && task.progress.manualPercent === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["progress", "manualPercent"],
        message: `manualPercent is required when progress.mode is manual`,
      });
    }
  });

export type Task = z.infer<typeof Task>;
export type Relations = z.infer<typeof Relations>;
export type Dependency = z.infer<typeof Dependency>;
export type Suggestion = z.infer<typeof Suggestion>;
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** JSON 序列化时的固定键序(Design §13),保证 diff 最小。 */
export const TASK_KEY_ORDER = [
  "$schema",
  "schemaVersion",
  "id",
  "slug",
  "title",
  "summary",
  "type",
  "status",
  "priority",
  "size",
  "sprint",
  "owner",
  "assignees",
  "driver",
  "tags",
  "relations",
  "dates",
  "effort",
  "lifecycle",
  "progress",
  "today",
  "copilot",
  "sync",
  "derived",
  "history",
] as const;
