// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import type { z } from "zod/v3";
import { Issue, TERMINAL_STATUSES, issue } from "../../shared/taskDocuments/common.js";
import { levelRanks } from "../../shared/taskDocuments/config.js";
import { checklistPercent } from "../../shared/taskDocuments/frontmatter.js";
import type { DerivedRelations as DerivedRelationsSchema } from "../../shared/taskDocuments/task.js";
import type { LoadedTask, Workspace } from "./workspace.js";

/**
 * 关系图引擎(Design §7.5)。
 *
 * 硬性要求(NFR-10):任何环、孤儿、层级倒置都不得导致崩溃或无限递归。
 * 因此这里**全部用迭代 + visited 集合**,不用递归。
 */

type RelationsDerived = z.infer<typeof DerivedRelationsSchema>;

export interface GraphResult {
  relations: Map<string, RelationsDerived>;
  percent: Map<string, number>;
  checklist: Map<string, { passed: number; total: number }>;
  topoOrder: string[];
  criticalPath: string[];
  cycles: string[][];
  roots: string[];
  hierarchy: { parent: string; child: string }[];
  dependencies: {
    from: string;
    to: string;
    type: string;
    hard: boolean;
    lag: number;
  }[];
  issues: Issue[];
}

const DEFAULT_SIZE_WEIGHT: Record<string, number> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
};

export function buildGraph(ws: Workspace): GraphResult {
  const { config } = ws;
  const issues: Issue[] = [];
  // broken 任务不参与建图 —— 它们的字段不可信
  const tasks = ws.tasks.filter((t) => !t.broken && t.task?.id);
  const byId = new Map(tasks.map((t) => [t.task.id, t]));
  const ranks = levelRanks(config);
  const dates = new Map<string, { due: string | null; started: string | null }>();
  for (const t of tasks) {
    const usable = { due: t.task.dates.due, started: t.task.dates.started };
    for (const field of ["due", "started"] as const) {
      const value = usable[field];
      if (value && !isCalendarDate(value)) {
        issues.push(issue("SCHEMA_INVALID", `dates.${field} is not a usable calendar date: ${value}`, {
          taskId: t.task.id, path: `${t.dir}/task.json`,
        }));
        usable[field] = null;
      }
    }
    dates.set(t.task.id, usable);
  }

  // -------------------------------------------------------------------------
  // 1. 从属:合法父边 + 环检测
  // -------------------------------------------------------------------------
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  tasks.forEach((t) => childrenOf.set(t.task.id, []));

  for (const t of tasks) {
    const { id } = t.task;
    const parent = t.task.relations.parent;
    if (!parent) continue;
    if (parent === id) {
      issues.push(issue("SELF_REFERENCE", `${id} is its own parent`, { taskId: id }));
      continue;
    }
    if (!byId.has(parent)) {
      issues.push(
        issue("ORPHAN_PARENT", `${id} has parent ${parent}, which does not exist`, {
          taskId: id,
          related: [parent],
        }),
      );
      continue;
    }
    parentOf.set(id, parent);
    childrenOf.get(parent)!.push(id);
  }

  const hierarchyCycles = findParentCycles(tasks.map((t) => t.task.id), parentOf);
  for (const cycle of hierarchyCycles) {
    for (const id of cycle) {
      issues.push(
        issue("CYCLE_HIERARCHY", `Hierarchy cycle: ${cycle.join(" → ")}`, {
          taskId: id,
          related: cycle,
        }),
      );
      // 打断环,后续计算才能进行
      const parent = parentOf.get(id);
      if (parent) {
        parentOf.delete(id);
        const siblings = childrenOf.get(parent);
        if (siblings) childrenOf.set(parent, siblings.filter((c) => c !== id));
      }
    }
  }

  // 层级 rank 校验
  for (const [id, parent] of parentOf) {
    const childLevel = byId.get(id)!.task.relations.level;
    const parentLevel = byId.get(parent)!.task.relations.level;
    const childRank = ranks[childLevel] ?? 0;
    const parentRank = ranks[parentLevel] ?? 0;
    if (parentRank >= childRank) {
      issues.push(
        issue(
          "LEVEL_INVERSION",
          `${id} (${childLevel}) is not below its parent ${parent} (${parentLevel})`,
          { taskId: id, related: [parent] },
        ),
      );
    } else if (config.hierarchy.strictLevelStep && childRank - parentRank !== 1) {
      issues.push(
        issue(
          "LEVEL_INVERSION",
          `strictLevelStep is on: ${id} and its parent ${parent} must differ by exactly one rank`,
          { taskId: id, related: [parent] },
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. 祖先链 / 深度 / 后代数
  // -------------------------------------------------------------------------
  const ancestorsOf = new Map<string, string[]>();
  for (const t of tasks) {
    const chain: string[] = [];
    const seen = new Set<string>([t.task.id]);
    let cur = parentOf.get(t.task.id);
    while (cur && !seen.has(cur)) {
      chain.unshift(cur);
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    ancestorsOf.set(t.task.id, chain);
    if (chain.length + 1 > config.hierarchy.maxDepth) {
      issues.push(
        issue(
          "DEPTH_EXCEEDED",
          `${t.task.id} is at depth ${chain.length + 1}, exceeding maxDepth=${config.hierarchy.maxDepth}`,
          { taskId: t.task.id },
        ),
      );
    }
  }

  const descendantCount = new Map<string, number>();
  for (const t of tasks) descendantCount.set(t.task.id, 0);
  for (const [id, chain] of ancestorsOf) {
    void id;
    for (const anc of chain) {
      descendantCount.set(anc, (descendantCount.get(anc) ?? 0) + 1);
    }
  }

  // -------------------------------------------------------------------------
  // 3. 依赖:合法边 + 环检测 + 拓扑序
  // -------------------------------------------------------------------------
  const dependencies: GraphResult["dependencies"] = [];
  const depsOf = new Map<string, string[]>(); // 后继 → 前驱[]
  const blocksOf = new Map<string, string[]>(); // 前驱 → 后继[]
  tasks.forEach((t) => {
    depsOf.set(t.task.id, []);
    blocksOf.set(t.task.id, []);
  });

  for (const t of tasks) {
    const { id } = t.task;
    for (const dep of t.task.relations.dependsOn) {
      if (dep.id === id) {
        issues.push(issue("SELF_REFERENCE", `${id} depends on itself`, { taskId: id }));
        continue;
      }
      if (!byId.has(dep.id)) {
        issues.push(
          issue("DANGLING_DEP", `${id} depends on ${dep.id}, which does not exist`, {
            taskId: id,
            related: [dep.id],
          }),
        );
        continue;
      }
      const relatives = new Set([
        ...(ancestorsOf.get(id) ?? []),
        ...descendantsOf(id, childrenOf),
      ]);
      if (config.dependency.warnOnRelativeDep && relatives.has(dep.id)) {
        issues.push(
          issue(
            "DEP_ON_RELATIVE",
            `${id} depends on its own ancestor or descendant ${dep.id}; hierarchy already implies order`,
            { taskId: id, related: [dep.id] },
          ),
        );
      }
      depsOf.get(id)!.push(dep.id);
      blocksOf.get(dep.id)!.push(id);
      dependencies.push({
        from: dep.id,
        to: id,
        type: dep.type,
        hard: dep.hard,
        lag: dep.lag,
      });
    }
  }

  const { order: topoOrder, remaining } = kahn(
    tasks.map((t) => t.task.id),
    depsOf,
  );
  const cycles: string[][] = [];
  if (remaining.length > 0) {
    cycles.push(remaining);
    for (const id of remaining) {
      issues.push(
        issue("CYCLE_DEPENDENCY", `Dependency cycle involving: ${remaining.join(", ")}`, {
          taskId: id,
          related: remaining,
        }),
      );
    }
  }
  for (const cycle of hierarchyCycles) cycles.push(cycle);

  // -------------------------------------------------------------------------
  // 4. 阻塞与可开工
  // -------------------------------------------------------------------------
  const blockedByOf = new Map<string, string[]>();
  for (const t of tasks) {
    const blocked = t.task.relations.dependsOn
      .filter((d) => d.hard)
      .filter((d) => {
        const target = byId.get(d.id);
        if (!target) return false;
        return !(TERMINAL_STATUSES as readonly string[]).includes(target.task.status);
      })
      .map((d) => d.id);
    blockedByOf.set(t.task.id, blocked);

    if (blocked.length > 0 && t.task.status === "in-progress") {
      issues.push(
        issue(
          "DEP_VIOLATION",
          `${t.task.id} is in-progress but blocked by ${blocked.join(", ")}`,
          { taskId: t.task.id, related: blocked },
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. 进度上卷(按深度从深到浅迭代,天然免递归)
  // -------------------------------------------------------------------------
  const checklistStats = new Map<string, { passed: number; total: number }>();
  const ownPercent = new Map<string, number>();
  for (const t of tasks) {
    const passed = t.checklist.filter((c) => c.checked).length;
    checklistStats.set(t.task.id, { passed, total: t.checklist.length });
    ownPercent.set(t.task.id, checklistPercent(t.checklist));
  }

  const sizeWeight = { ...DEFAULT_SIZE_WEIGHT, ...config.hierarchy.rollup.sizeWeight };
  const percent = new Map<string, number>();
  const rollupPercent = new Map<string, number>();
  const byDepthDesc = [...tasks].sort(
    (a, b) =>
      (ancestorsOf.get(b.task.id)?.length ?? 0) -
      (ancestorsOf.get(a.task.id)?.length ?? 0),
  );

  for (const t of byDepthDesc) {
    const { id } = t.task;
    const kids = childrenOf.get(id) ?? [];
    const own = ownPercent.get(id) ?? 0;

    let rolled = own;
    if (kids.length > 0) {
      const parts: { w: number; p: number }[] = kids.map((k) => ({
        w: weightOf(byId.get(k)!, sizeWeight),
        p: percent.get(k) ?? 0,
      }));
      const includeSelf =
        t.task.progress.rollupIncludeSelf && (checklistStats.get(id)?.total ?? 0) > 0;
      if (includeSelf) {
        const avg = parts.reduce((s, p) => s + p.w, 0) / parts.length;
        parts.push({ w: weightOf(t, sizeWeight) || avg, p: own });
      }
      const totalW = parts.reduce((s, p) => s + p.w, 0);
      rolled = totalW > 0 ? Math.round(parts.reduce((s, p) => s + p.w * p.p, 0) / totalW) : 0;
    }
    rollupPercent.set(id, rolled);

    const mode =
      t.task.progress.mode === "checklist" && kids.length > 0
        ? "rollup"
        : t.task.progress.mode;
    const final =
      mode === "manual" ? (t.task.progress.manualPercent ?? 0) : mode === "rollup" ? rolled : own;
    percent.set(id, final);

    if (mode === "manual" && Math.abs(final - rolled) > 25) {
      issues.push(
        issue(
          "ROLLUP_MISMATCH",
          `${id} has a manual progress of ${final}% but children roll up to ${rolled}%`,
          { taskId: id },
        ),
      );
    }
  }

  // 父任务 done 时子任务必须都已终态(H6)
  for (const t of tasks) {
    if (t.task.status !== "done") continue;
    const open = (childrenOf.get(t.task.id) ?? []).filter((c) => {
      const child = byId.get(c)!;
      return !(TERMINAL_STATUSES as readonly string[]).includes(child.task.status);
    });
    if (open.length > 0) {
      issues.push(
        issue(
          "PARENT_DONE_EARLY",
          `${t.task.id} is done but child tasks ${open.join(", ")} are not finished`,
          { taskId: t.task.id, related: open },
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. 关键路径:依赖 DAG 上按工时求最长路径
  // -------------------------------------------------------------------------
  const criticalPath = longestPath(topoOrder, depsOf, (id) =>
    weightOf(byId.get(id)!, sizeWeight),
  );
  const onCritical = new Set(criticalPath);

  // -------------------------------------------------------------------------
  // 7. 排期提示 + 悬空引用
  // -------------------------------------------------------------------------
  for (const t of tasks) {
    const parent = parentOf.get(t.task.id);
    if (parent) {
      const parentDue = dates.get(parent)?.due;
      const due = dates.get(t.task.id)?.due;
      if (parentDue && due && due > parentDue) {
        issues.push(
          issue(
            "SCHEDULE_CONFLICT",
            `${t.task.id} is due ${due}, later than its parent ${parent} (${parentDue})`,
            { taskId: t.task.id, related: [parent] },
          ),
        );
      }
    }
    for (const mentioned of t.mentions) {
      if (!byId.has(mentioned)) {
        issues.push(
          issue("DANGLING_MENTION", `Document references [[${mentioned}]], which does not exist`, {
            taskId: t.task.id,
            related: [mentioned],
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. 汇总
  // -------------------------------------------------------------------------
  const relations = new Map<string, RelationsDerived>();
  for (const t of tasks) {
    const { id } = t.task;
    const chain = ancestorsOf.get(id) ?? [];
    const kids = childrenOf.get(id) ?? [];
    const blocked = blockedByOf.get(id) ?? [];
    const parentStatus = parentOf.get(id)
      ? byId.get(parentOf.get(id)!)!.task.status
      : null;
    const earliest = earliestStart(t, dates, issues);
    const started = dates.get(id)?.started;

    if (earliest && started && started < earliest) {
      issues.push(
        issue(
          "SCHEDULE_CONFLICT",
          `${id} started ${started}, earlier than the dependency-allowed start ${earliest}`,
          { taskId: id },
        ),
      );
    }

    relations.set(id, {
      children: kids,
      childCount: kids.length,
      descendantCount: descendantCount.get(id) ?? 0,
      depth: chain.length,
      ancestors: chain,
      rootId: chain[0] ?? id,
      isLeaf: kids.length === 0,
      blocks: blocksOf.get(id) ?? [],
      blockedBy: blocked,
      readyToStart:
        blocked.length === 0 &&
        (parentStatus === null || !["backlog", "dropped"].includes(parentStatus)),
      earliestStart: earliest,
      rolledDue: rolledDue(id, childrenOf, dates),
      rollupPercent: rollupPercent.get(id) ?? 0,
      onCriticalPath: onCritical.has(id),
    });
  }

  return {
    relations,
    percent,
    checklist: checklistStats,
    topoOrder,
    criticalPath,
    cycles,
    roots: tasks.filter((t) => !parentOf.has(t.task.id)).map((t) => t.task.id),
    hierarchy: [...parentOf].map(([child, parent]) => ({ parent, child })),
    dependencies,
    issues,
  };
}

// ---------------------------------------------------------------------------
// 工具函数(全部迭代实现)
// ---------------------------------------------------------------------------

function weightOf(t: LoadedTask, sizeWeight: Record<string, number>): number {
  const est = t.task.effort?.estimateHours;
  if (typeof est === "number" && est > 0) return est;
  const size = t.task.size;
  if (size && sizeWeight[size]) return sizeWeight[size]!;
  return 1;
}

function descendantsOf(id: string, childrenOf: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack = [...(childrenOf.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(childrenOf.get(cur) ?? []));
  }
  return out;
}

function rolledDue(
  id: string,
  childrenOf: Map<string, string[]>,
  dates: Map<string, { due: string | null }>,
): string | null {
  let max = dates.get(id)?.due ?? null;
  for (const d of descendantsOf(id, childrenOf)) {
    const due = dates.get(d)?.due ?? null;
    if (due && (!max || due > max)) max = due;
  }
  return max;
}

/**
 * 最早开工日(§7.5)。v1 只有 FS / SS 参与推算(Q7)。
 *   FS: predecessor.due   + lag + 1天
 *   SS: predecessor.start + lag
 */
function earliestStart(
  t: LoadedTask,
  dates: Map<string, { due: string | null; started: string | null }>,
  issues: Issue[],
): string | null {
  let max: string | null = null;
  for (const dep of t.task.relations.dependsOn) {
    const pred = dates.get(dep.id);
    if (!pred) continue;
    let date: string | null = null;
    let days = dep.lag;
    if (dep.type === "finish-to-start") {
      date = pred.due;
      days += 1;
    } else if (dep.type === "start-to-start") {
      date = pred.started;
    }
    if (!date) continue;
    const base = Number.isSafeInteger(dep.lag) ? addDays(date, days) : null;
    if (!base) {
      issues.push(issue("SCHEMA_INVALID", `Cannot compute dependency date for ${dep.id} with lag ${dep.lag}: result is outside the supported calendar range.`, {
        taskId: t.task.id, path: `${t.dir}/task.json`, related: [dep.id],
      }));
      continue;
    }
    if (base && (!max || base > max)) max = base;
  }
  return max;
}

function isCalendarDate(date: string): boolean {
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function addDays(date: string, days: number): string | null {
  if (!Number.isSafeInteger(days) || !isCalendarDate(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 0 || d.getUTCFullYear() > 9999) return null;
  return d.toISOString().slice(0, 10);
}

/** 沿 parent 链找环。返回环上节点数组的列表。 */
function findParentCycles(
  ids: string[],
  parentOf: Map<string, string>,
): string[][] {
  const cycles: string[][] = [];
  const settled = new Set<string>();

  for (const start of ids) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string | undefined = start;

    while (cur && !settled.has(cur)) {
      if (onPath.has(cur)) {
        cycles.push(path.slice(onPath.get(cur)!));
        break;
      }
      onPath.set(cur, path.length);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    for (const n of path) settled.add(n);
  }
  return cycles;
}

/** Kahn 拓扑排序。remaining 非空即存在环。 */
function kahn(
  ids: string[],
  depsOf: Map<string, string[]>,
): { order: string[]; remaining: string[] } {
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, (depsOf.get(id) ?? []).length);

  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    for (const dep of depsOf.get(id) ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(id);
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of dependents.get(cur) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  const done = new Set(order);
  return { order, remaining: ids.filter((id) => !done.has(id)) };
}

/** DAG 上按权重求最长路径,作为关键路径。 */
function longestPath(
  topoOrder: string[],
  depsOf: Map<string, string[]>,
  weight: (id: string) => number,
): string[] {
  if (topoOrder.length === 0) return [];
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();

  for (const id of topoOrder) {
    let best = 0;
    let from: string | null = null;
    for (const dep of depsOf.get(id) ?? []) {
      const d = dist.get(dep);
      if (d !== undefined && d > best) {
        best = d;
        from = dep;
      }
    }
    dist.set(id, best + weight(id));
    prev.set(id, from);
  }

  let end: string | null = null;
  let max = -1;
  for (const [id, d] of dist) {
    // 只在"有前驱"的节点里挑终点 —— 一个孤立的大工时节点不构成路径
    if (prev.get(id) == null) continue;
    if (d > max) {
      max = d;
      end = id;
    }
  }

  const path: string[] = [];
  const seen = new Set<string>();
  let cur = end;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  // 单点且无依赖时不算关键路径
  return path.length > 1 ? path : [];
}
