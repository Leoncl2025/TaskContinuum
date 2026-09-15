// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import path from 'node:path'
import { buildGraph } from './graph.js'
import { hashOf } from './hash.js'
import type { Workspace, LoadedTask } from './workspace.js'
import type { Issue } from '../../shared/taskDocuments/common.js'
import type { IndexFile, TaskSummary } from '../../shared/taskDocuments/indexFile.js'
export interface BuildResult {
  index: IndexFile;
  workspace: Workspace;
  issues: Issue[];
}

export function buildIndex(ws: Workspace, sources: Map<string, string>): BuildResult {

  const graph = buildGraph(ws);

  const healthy = ws.tasks.filter((t) => !t.broken);
  const brokenTasks = ws.tasks.filter((t) => t.broken);

  const tasks: TaskSummary[] = healthy.map((t) => toSummary(t, graph, ws));

  const knownIds = new Set([
    ...tasks.map((t) => t.id),
    ...brokenTasks.map((t) => t.task?.id).filter(Boolean),
  ]);

  // 每条 issue 只出现一次:任务级的挂在卡片或 broken 条目上,
  // 这里只收工作区级、以及指向不存在任务的孤儿 issue。
  const unattached: Issue[] = [
    ...ws.issues,
    ...graph.issues.filter((i) => !i.taskId || !knownIds.has(i.taskId)),
  ];

  const issues: Issue[] = [
    ...ws.issues,
    ...ws.tasks.flatMap((t) => t.issues),
    ...graph.issues,
  ];

  const today = new Date().toISOString().slice(0, 10);
  const index: IndexFile = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    workspaceHash: hashOf([...sources].sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => `${path.relative(ws.root, file)}:${hashOf(text)}`).join("\n")),
    tasks,
    broken: brokenTasks.map((t) => ({
      id: t.task?.id ?? path.basename(t.dir),
      dir: t.dir.replace(/\\/g, "/"),
      issues: t.issues,
    })),
    issues: unattached,
    graph: {
      roots: graph.roots,
      hierarchy: graph.hierarchy,
      dependencies: graph.dependencies.map((d) => ({
        from: d.from,
        to: d.to,
        type: d.type as IndexFile["graph"]["dependencies"][number]["type"],
        hard: d.hard,
        lag: d.lag,
      })),
      topoOrder: graph.topoOrder,
      criticalPath: graph.criticalPath,
      cycles: graph.cycles,
      issues: graph.issues,
    },
    stats: {
      total: tasks.length,
      byStatus: countBy(tasks, (t) => t.status),
      byLevel: countBy(tasks, (t) => t.relations.level),
      overdue: tasks.filter(
        (t) => t.due && t.due < today && !["done", "dropped"].includes(t.status),
      ).length,
      dueToday: tasks.filter((t) => t.due === today).length,
      blocked: tasks.filter((t) => t.relations.blockedBy.length > 0).length,
      readyToStart: tasks.filter(
        (t) => t.relations.readyToStart && ["backlog", "ready"].includes(t.status),
      ).length,
      unhealthy: tasks.filter((t) => !t.healthy).length,
      unloadable: brokenTasks.length,
    },
  };

  return { index, workspace: ws, issues };
}

function toSummary(
  t: LoadedTask,
  graph: ReturnType<typeof buildGraph>,
  ws: Workspace,
): TaskSummary {
  const { task } = t;
  const rel = graph.relations.get(task.id);
  const own = t.issues.concat(graph.issues.filter((i) => i.taskId === task.id));
  const nextMs =
    t.milestones.find((m) => m.state === "doing") ??
    t.milestones.find((m) => m.state === "todo") ??
    null;

  return {
    id: task.id,
    dir: t.dir.replace(/\\/g, "/"),
    hash: t.taskHash,
    archived: t.archived,
    hasSkill: t.skill !== null,
    title: task.title,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    driver: task.driver,
    sprint: task.sprint ?? null,
    tags: task.tags,
    due: task.dates.due ?? null,
    percent: graph.percent.get(task.id) ?? 0,
    checklist: graph.checklist.get(task.id) ?? { passed: 0, total: 0 },
    lifecycle: Object.fromEntries(
      Object.entries(task.lifecycle).map(([k, v]) => [k, v.state]),
    ),
    relations: {
      level: task.relations.level,
      parent: task.relations.parent,
      depth: rel?.depth ?? 0,
      ancestors: rel?.ancestors ?? [],
      rootId: rel?.rootId ?? null,
      children: rel?.children ?? [],
      descendantCount: rel?.descendantCount ?? 0,
      isLeaf: rel?.isLeaf ?? true,
      dependsOn: task.relations.dependsOn.map((d) => d.id),
      blocks: rel?.blocks ?? [],
      blockedBy: rel?.blockedBy ?? [],
      readyToStart: rel?.readyToStart ?? true,
      onCriticalPath: rel?.onCriticalPath ?? false,
      rollupPercent: rel?.rollupPercent ?? 0,
    },
    today: task.today
      ? { date: task.today.date ?? null, nextAction: task.today.nextAction ?? null }
      : null,
    copilot: task.copilot
      ? {
          handoff: task.copilot.handoff,
          phase: task.copilot.phase ?? null,
          contextScope: task.copilot.contextScope,
        }
      : null,
    pinnedLinks: t.links
      .filter((l) => l.pinned)
      .slice(0, 3)
      .map((l) => ({ kind: l.kind, title: l.title, url: l.url })),
    milestoneNext: nextMs
      ? { id: nextMs.id, title: nextMs.title, due: nextMs.due }
      : null,
    hasNewContext: false,
    healthy: !own.some((i) => i.severity === "error") && ws.issues.length >= 0,
    issues: own,
  };
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
