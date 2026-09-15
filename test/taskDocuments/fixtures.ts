// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { Config } from "../../src/shared/taskDocuments/config.js";
import { buildGraph } from "../../src/main/taskDocuments/graph.js";
import type { TaskSummary } from "../../src/shared/taskDocuments/indexFile.js";
import type { Task } from "../../src/shared/taskDocuments/task.js";
import { Task as TaskSchema } from "../../src/shared/taskDocuments/task.js";
import type { LoadedTask, Workspace } from "../../src/main/taskDocuments/workspace.js";

/**
 * 测试夹具。刻意**不读磁盘** —— 图引擎和排版是纯逻辑,
 * 让它们依赖真实文件只会让测试变慢,而且构造不出该测的边界情况(环、孤儿、层级倒置)。
 */

export interface TaskSpec {
  id: string;
  level?: string;
  parent?: string | null;
  status?: string;
  priority?: string;
  size?: string | null;
  due?: string | null;
  started?: string | null;
  dependsOn?: { id: string; type?: string; hard?: boolean; lag?: number }[];
  progressMode?: string;
  manualPercent?: number | null;
  rollupIncludeSelf?: boolean;
  estimateHours?: number | null;
}

export function makeTask(spec: TaskSpec): Task {
  return TaskSchema.parse({
    schemaVersion: "1.0.0",
    id: spec.id,
    slug: spec.id.toLowerCase(),
    title: `Task ${spec.id}`,
    type: "feature",
    status: spec.status ?? "backlog",
    priority: spec.priority ?? "P1",
    size: spec.size ?? null,
    owner: "tester",
    relations: {
      level: spec.level ?? "task",
      parent: spec.parent ?? null,
      dependsOn: (spec.dependsOn ?? []).map((d) => ({
        id: d.id,
        type: d.type ?? "finish-to-start",
        hard: d.hard ?? true,
        lag: d.lag ?? 0,
      })),
    },
    dates: {
      created: "2026-01-01",
      started: spec.started ?? null,
      due: spec.due ?? null,
      // schema 要求 done 必须有 completed,夹具自动补上,免得每个用例都写一遍
      completed: spec.status === "done" ? "2026-02-01" : null,
    },
    effort: { estimateHours: spec.estimateHours ?? null, spentHours: 0 },
    lifecycle: {
      requirement: { state: "todo" },
      plan: { state: "todo" },
      design: { state: "todo" },
      checklist: { state: "todo" },
      reference: { state: "todo" },
    },
    progress: {
      mode: spec.progressMode ?? "checklist",
      manualPercent: spec.manualPercent ?? null,
      rollupIncludeSelf: spec.rollupIncludeSelf ?? true,
    },
  });
}

export interface LoadedSpec extends TaskSpec {
  /** 勾选数 / 总数,驱动 checklist 百分比 */
  checked?: number;
  total?: number;
  broken?: boolean;
  archived?: boolean;
  skill?: string | null;
}

export function makeLoaded(spec: LoadedSpec): LoadedTask {
  const total = spec.total ?? 0;
  const checked = spec.checked ?? 0;
  return {
    task: makeTask(spec),
    dir: `tasks/${spec.id}-fixture`,
    broken: spec.broken ?? false,
    archived: spec.archived ?? false,
    taskHash: `hash-${spec.id}`,
    checklist: Array.from({ length: total }, (_, i) => ({
      id: `CL-${String(i + 1).padStart(3, "0")}`,
      text: `item ${i + 1}`,
      checked: i < checked,
      line: i + 1,
    })),
    links: [],
    milestones: [],
    mentions: [],
    skill: spec.skill ?? null,
    designs: [],
    refFiles: [],
    issues: [],
  };
}

export const LEVELS = [
  { id: "epic", rank: 0, title: "Epic" },
  { id: "feature", rank: 1, title: "Feature" },
  { id: "story", rank: 2, title: "Story" },
  { id: "task", rank: 3, title: "Task" },
  { id: "subtask", rank: 4, title: "Subtask" },
];

export const COLUMNS = [
  { id: "backlog", title: "Backlog", statuses: ["backlog"] },
  { id: "shaping", title: "Shaping", statuses: ["analyzing", "designing"] },
  { id: "ready", title: "Ready", statuses: ["ready"] },
  { id: "doing", title: "In Progress", statuses: ["in-progress", "blocked"], wip: 2 },
  { id: "review", title: "In Review", statuses: ["in-review"] },
  { id: "done", title: "Done", statuses: ["done", "dropped"] },
];

export function makeConfig(overrides: Record<string, unknown> = {}) {
  return Config.parse({
    schemaVersion: "1.0.0",
    workspace: "fixture",
    levels: LEVELS,
    columns: COLUMNS,
    members: [{ id: "tester", name: "Tester" }],
    ...overrides,
  });
}

export function makeWorkspace(
  specs: LoadedSpec[],
  configOverrides: Record<string, unknown> = {},
): Workspace {
  return {
    root: "/fixture",
    config: makeConfig(configOverrides),
    tasks: specs.map(makeLoaded),
    issues: [],
  };
}

/** 只关心 code 的场景下,把 issues 压成 code 列表 */
export function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code);
}

/**
 * 走一遍真实的图引擎,产出看板 / 树真正消费的 TaskSummary。
 * 手搓 summary 会让排版测试与图的实际输出脱节,那样测了等于没测。
 */
export function summarise(specs: LoadedSpec[]): TaskSummary[] {
  const ws = makeWorkspace(specs);
  const g = buildGraph(ws);
  return ws.tasks
    .filter((t) => !t.broken)
    .map((t) => {
      const rel = g.relations.get(t.task.id)!;
      return {
        id: t.task.id,
        dir: t.dir,
        hash: t.taskHash,
        archived: t.archived,
        hasSkill: t.skill !== null,
        title: t.task.title,
        status: t.task.status,
        priority: t.task.priority,
        owner: t.task.owner,
        driver: t.task.driver,
        sprint: t.task.sprint,
        tags: t.task.tags,
        due: t.task.dates.due,
        percent: g.percent.get(t.task.id) ?? 0,
        checklist: g.checklist.get(t.task.id) ?? { passed: 0, total: 0 },
        lifecycle: Object.fromEntries(
          Object.entries(t.task.lifecycle).map(([k, v]) => [k, v.state]),
        ),
        relations: {
          level: t.task.relations.level,
          parent: t.task.relations.parent,
          depth: rel.depth,
          ancestors: rel.ancestors,
          rootId: rel.rootId,
          children: rel.children,
          descendantCount: rel.descendantCount,
          isLeaf: rel.isLeaf,
          dependsOn: t.task.relations.dependsOn.map((d) => d.id),
          blocks: rel.blocks,
          blockedBy: rel.blockedBy,
          readyToStart: rel.readyToStart,
          onCriticalPath: rel.onCriticalPath,
          rollupPercent: rel.rollupPercent,
        },
        today: null,
        copilot: null,
        pinnedLinks: [],
        milestoneNext: null,
        hasNewContext: false,
        healthy: true,
        issues: [],
      } satisfies TaskSummary;
    });
}

export function rootsOf(specs: LoadedSpec[]): string[] {
  return buildGraph(makeWorkspace(specs)).roots;
}
