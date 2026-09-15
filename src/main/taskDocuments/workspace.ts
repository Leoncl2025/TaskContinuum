// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { DocumentFiles } from "./files.js";
import path from "node:path";
import matter from "@11ty/gray-matter";
import { z } from "zod/v3";
import { Issue, TaskId, issue } from "../../shared/taskDocuments/common.js";
import { Config } from "../../shared/taskDocuments/config.js";
import { hashOf } from "./hash.js";
import {
  type ChecklistItem,
  FRONT_MATTER_SCHEMAS,
  Link,
  Milestone,
  parseChecklist,
  parseMentions,
} from "../../shared/taskDocuments/frontmatter.js";
import { LIFECYCLE_PATHS, Task } from "../../shared/taskDocuments/task.js";

export interface LoadedTask {
  task: Task;
  /** 相对工作区根的目录,例如 tasks/T-0001-bootstrap */
  dir: string;
  /**
   * true = task.json 读不了或不合法。
   * 这种任务**不能当正常任务参与建图**,但必须在 UI 上看得见 ——
   * 静默消失比报错更危险(NFR-07)。
   */
  broken: boolean;
  /** true = 位于 archive/。仍然参与建图,但默认不出现在看板与树上。 */
  archived: boolean;
  /** task.json 的内容哈希,UI 用它做乐观锁 */
  taskHash: string;
  checklist: ChecklistItem[];
  links: Link[];
  milestones: Milestone[];
  mentions: string[];
  /**
   * skill.md 的全文,不存在则为 null。
   *
   * 刻意不给它 schema:这是写给 AI 看的领域知识,不是结构化数据。
   * 加一层 front matter 校验只会多一种让工作区变红的方式,换不来任何东西。
   */
  skill: string | null;
  designs: { id: string; file: string; state: string; supersedes: string | null }[];
  refFiles: string[];
  issues: Issue[];
}

export interface Workspace {
  root: string;
  config: Config;
  tasks: LoadedTask[];
  issues: Issue[];
}

const DIR_NAME = /^(T-\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function loadWorkspace(root: string, fs = new DocumentFiles(root)): Workspace {
  const issues: Issue[] = [];
  const config = loadConfig(root, issues, fs);
  const tasksRoot = path.join(root, config.paths.tasks);

  const tasks: LoadedTask[] = [];
  const exists = (file: string): boolean => {
    try { return fs.existsSync(file); }
    catch (error) {
      issues.push(issue("SCHEMA_INVALID", error instanceof Error ? error.message : String(error), { path: path.relative(root, file) }));
      return false;
    }
  };
  const tasksExist = exists(tasksRoot);
  if (!tasksExist) {
    issues.push(
      issue("MISSING_DOC", `Tasks directory not found: ${config.paths.tasks}/`, {
        path: config.paths.tasks,
      }),
    );
  }

  const loadDirectory = (directory: string, archived: boolean) => {
    try {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (tasks.length >= 1000) throw new Error('The workspace exceeds the 1,000 task limit.');
        const dir = path.join(directory, entry.name);
        let t: LoadedTask;
        try { t = loadTask(root, dir, fs); }
        catch (error) {
          t = {
            task: { id: /^(T-\d+)-/.exec(entry.name)?.[1] ?? entry.name } as Task,
            dir, broken: true, archived, taskHash: "", checklist: [], links: [],
            milestones: [], mentions: [], skill: null, designs: [], refFiles: [],
            issues: [issue("SCHEMA_INVALID", error instanceof Error ? error.message : String(error), { path: dir })],
          };
        }
        t.archived = archived;
        tasks.push(t);
      }
    } catch (error) {
      issues.push(issue("SCHEMA_INVALID", error instanceof Error ? error.message : String(error), { path: directory }));
    }
  };
  if (tasksExist) loadDirectory(config.paths.tasks, false);

  // 归档目录照样加载。归档只是"不想在看板上再看到它",不是"它不存在了" ——
  // 别的任务可能还 dependsOn 它,把它从图里拿掉会立刻产生 DANGLING_DEP。
  const archiveRoot = path.join(root, config.paths.archive);
  if (exists(archiveRoot)) {
    loadDirectory(config.paths.archive, true);
  }

  // 全局唯一性:同一个 task id 只能出现一次
  const byId = new Map<string, LoadedTask>();
  for (const t of tasks) {
    if (t.broken) continue;
    const prev = byId.get(t.task.id);
    if (prev) {
      issues.push(
        issue("DUPLICATE_ID", `Task id ${t.task.id} appears more than once`, {
          taskId: t.task.id,
          related: [prev.dir, t.dir],
        }),
      );
    }
    byId.set(t.task.id, t);
  }

  return { root, config, tasks, issues };
}

function loadConfig(root: string, issues: Issue[], fs: DocumentFiles): Config {
  const file = path.join(root, ".agentdesk", "config.json");
  let raw: unknown;
  try {
    raw = readJson(file, fs);
  } catch (err) {
    issues.push(
      issue("SCHEMA_INVALID", (err as Error).message, { path: ".agentdesk/config.json" }),
    );
    raw = {};
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push(
        issue("SCHEMA_INVALID", `config.json ${err.path.join(".")}: ${err.message}`, {
          path: ".agentdesk/config.json",
        }),
      );
    }
    // 用一个能让流程继续的最小配置,避免因配置坏掉而看不到其它问题
    return Config.parse({
      schemaVersion: "1.0",
      workspace: "unknown",
      levels: [
        { id: "epic", rank: 0, title: "Epic" },
        { id: "feature", rank: 1, title: "Feature" },
        { id: "story", rank: 2, title: "Story" },
        { id: "task", rank: 3, title: "Task" },
        { id: "subtask", rank: 4, title: "Subtask" },
      ],
      columns: [
        {
          id: "all",
          title: "All",
          statuses: [
            "backlog",
            "analyzing",
            "designing",
            "ready",
            "in-progress",
            "in-review",
            "blocked",
            "done",
            "dropped",
          ],
        },
      ],
      members: [{ id: "unknown", name: "unknown" }],
    });
  }
  return parsed.data;
}

export function loadTask(root: string, dir: string, fs = new DocumentFiles(root)): LoadedTask {
  const abs = path.join(root, dir);
  const issues: Issue[] = [];
  const name = path.basename(dir);
  /** 文件坏掉时仍能从目录名拿到 id,至少能告诉人"哪个任务坏了" */
  const idFromDir = /^(T-\d+)-/.exec(name)?.[1];
  const diagnosticId = TaskId.safeParse(idFromDir).success ? idFromDir : undefined;

  const brokenTask = (): LoadedTask => ({
    task: { id: idFromDir ?? name } as unknown as Task,
    dir,
    broken: true,
    archived: false,
    taskHash: "",
    checklist: [],
    links: [],
    milestones: [],
    mentions: [],
    skill: null,
    designs: [],
    refFiles: [],
    issues,
  });

  const taskFile = path.join(abs, "task.json");
  if (!fs.existsSync(taskFile)) {
    issues.push(
      issue("SCHEMA_INVALID", `${dir} has no task.json`, {
        ...(diagnosticId ? { taskId: diagnosticId } : {}),
        path: `${dir}/task.json`,
      }),
    );
    return brokenTask();
  }

  let raw: unknown;
  let taskHash = "";
  try {
    const text = fs.readFileSync(taskFile, "utf8");
    taskHash = hashOf(text);
    raw = JSON.parse(text);
  } catch (err) {
    // 语法错误的 JSON 不能把整个工作区拖崩
    issues.push(
      issue("SCHEMA_INVALID", `Failed to read ${taskFile}: ${(err as Error).message}`, {
        ...(diagnosticId ? { taskId: diagnosticId } : {}),
        path: `${dir}/task.json`,
      }),
    );
    return brokenTask();
  }

  const parsed = Task.safeParse(raw);
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push(
        issue("SCHEMA_INVALID", `${err.path.join(".") || "(root)"}: ${err.message}`, {
          ...(diagnosticId ? { taskId: diagnosticId } : {}),
          path: `${dir}/task.json`,
        }),
      );
    }
    return brokenTask();
  }
  const task = parsed.data;

  // 目录名必须是 <id>-<slug>
  const m = DIR_NAME.exec(name);
  if (!m || m[1] !== task.id || m[2] !== task.slug) {
    issues.push(
      issue(
        "DIR_NAME_MISMATCH",
        `Directory "${name}" does not match task.json id/slug, expected "${task.id}-${task.slug}"`,
        { taskId: task.id, path: dir },
      ),
    );
  }

  const mentions = new Set<string>();
  let checklist: ChecklistItem[] = [];
  let links: Link[] = [];
  let milestones: Milestone[] = [];

  // ---- 生命周期文档 ----
  for (const [key, rel] of Object.entries(LIFECYCLE_PATHS)) {
    const lifecycleKey = key as keyof typeof LIFECYCLE_PATHS;
    const state = task.lifecycle[lifecycleKey].state;
    const target = path.join(abs, rel);
    const exists = fs.existsSync(target);

    if (!exists) {
      if (state !== "todo" && state !== "skipped") {
        issues.push(
          issue(
            "MISSING_DOC",
            `lifecycle.${key}.state is "${state}" but ${rel} does not exist`,
            { taskId: task.id, path: `${dir}/${rel}` },
          ),
        );
      }
      continue;
    }
    if (lifecycleKey === "design") continue; // 目录,下面单独处理

    const docKey = lifecycleKey === "requirement" ? "requirement-analysis" : lifecycleKey;
    const body = readFrontMatter(
      target,
      `${dir}/${rel}`,
      FRONT_MATTER_SCHEMAS[docKey as keyof typeof FRONT_MATTER_SCHEMAS],
      task.id,
      issues,
      fs,
    );
    if (!body) continue;

    parseMentions(body.content).forEach((id) => mentions.add(id));

    if (lifecycleKey === "checklist") {
      const result = parseChecklist(body.content);
      checklist = result.items;
      for (const dup of result.duplicates) {
        issues.push(
          issue("DUPLICATE_CHECKLIST_ID", `Duplicate checklist id ${dup}`, {
            taskId: task.id,
            path: `${dir}/${rel}`,
          }),
        );
      }
    } else if (lifecycleKey === "reference") {
      links = (body.data as { links?: Link[] }).links ?? [];
    } else if (lifecycleKey === "plan") {
      milestones = (body.data as { milestones?: Milestone[] }).milestones ?? [];
    }
  }

  // ---- designs/ ----
  const designs: LoadedTask["designs"] = [];
  const designDir = path.join(abs, LIFECYCLE_PATHS.design);
  if (fs.existsSync(designDir)) {
    for (const file of fs.readdirSync(designDir)) {
      if (!file.endsWith(".md")) continue;
      const body = readFrontMatter(
        path.join(designDir, file),
        `${dir}/designs/${file}`,
        FRONT_MATTER_SCHEMAS.design,
        task.id,
        issues,
        fs,
      );
      if (!body) continue;
      const data = body.data as { id: string; state: string; supersedes: string | null };
      designs.push({
        id: data.id,
        file,
        state: data.state,
        supersedes: data.supersedes ?? null,
      });
      parseMentions(body.content).forEach((id) => mentions.add(id));
    }
  }

  // ---- ref/ ----
  const refDir = path.join(abs, "ref");
  const refFiles = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter((f) => f.endsWith(".txt"))
    : [];
  for (const file of refFiles) {
    try { fs.readFileSync(path.join(refDir, file), "utf8"); }
    catch (error) {
      issues.push(issue("SCHEMA_INVALID", error instanceof Error ? error.message : String(error), { taskId: task.id, path: `${dir}/ref/${file}` }));
    }
  }

  // ---- 交叉引用:milestone 引用的 CL 必须存在 ----
  const clIds = new Set(checklist.map((c) => c.id));
  for (const ms of milestones) {
    for (const cl of ms.checklist) {
      if (!clIds.has(cl)) {
        issues.push(
          issue(
            "DANGLING_CHECKLIST_REF",
            `Plan.md milestone ${ms.id} references ${cl}, which does not exist`,
            { taskId: task.id, path: `${dir}/Plan.md` },
          ),
        );
      }
    }
  }

  // ---- 同步源必须绑定到真实链接 ----
  const linkIds = new Set(links.map((l) => l.id));
  for (const src of task.sync?.sources ?? []) {
    if (!linkIds.has(src.ref)) {
      issues.push(
        issue(
          "DANGLING_DEP",
          `sync source ${src.id} is bound to link ${src.ref}, which is not in Reference.md`,
          { taskId: task.id, path: `${dir}/task.json` },
        ),
      );
    }
  }

  return {
    task,
    dir,
    broken: false,
    archived: false,
    taskHash,
    checklist,
    links,
    milestones,
    mentions: [...mentions],
    skill: readSkill(abs, fs, issues, task.id),
    designs,
    refFiles,
    issues,
  };
}

function readFrontMatter(
  file: string,
  relPath: string,
  schema: z.ZodTypeAny,
  taskId: string,
  issues: Issue[],
  fs: DocumentFiles,
): { data: unknown; content: string } | null {
  let parsedFile;
  try {
    // Supplying options disables gray-matter's process-global content cache.
    parsedFile = matter(fs.readFileSync(file, "utf8"), {});
  } catch (err) {
    issues.push(
      issue("FRONTMATTER_INVALID", `YAML parse failed: ${(err as Error).message}`, {
        taskId,
        path: relPath,
      }),
    );
    return null;
  }
  const result = schema.safeParse(parsedFile.data);
  if (!result.success) {
    for (const err of result.error.issues) {
      issues.push(
        issue(
          "FRONTMATTER_INVALID",
          `front matter ${err.path.join(".") || "(root)"}: ${err.message}`,
          { taskId, path: relPath },
        ),
      );
    }
    return null;
  }
  return { data: result.data, content: parsedFile.content };
}

function readJson(file: string, fs: DocumentFiles): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
  }
}

/**
 * 任务级 skill.md —— "在这个任务上干活需要先知道的事"。
 *
 * 读不到就当没有:缺一份可选的指导,不该让一个任务变成 broken。
 */
function readSkill(abs: string, fs: DocumentFiles, issues: Issue[], taskId: string): string | null {
  const file = path.join(abs, "skill.md");
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  } catch (error) {
    issues.push(issue("SCHEMA_INVALID", error instanceof Error ? error.message : String(error), { taskId, path: file }));
    return null;
  }
}

export { TaskId };
