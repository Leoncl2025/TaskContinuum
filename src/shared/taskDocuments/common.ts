// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";

/** 当前 schema 版本。破坏性变更时递增,并在 migrations/ 下提供迁移脚本。 */
export const SCHEMA_VERSION = "1.0";

// ---------------------------------------------------------------------------
// ID 与基础标量
// ID 一经分配不得复用或改号 —— 这是跨文档引用的基石(DD-7)。
// ---------------------------------------------------------------------------

export const TaskId = z
  .string()
  .regex(/^T-\d{4}$/, "task id must look like T-0001");

export const JobId = z
  .string()
  .regex(/^J-\d{8}-\d{3}$/, "job id must look like J-20260728-001");

export const DesignId = z
  .string()
  .regex(/^D-\d{3}$/, "design id must look like D-001");

export const ChecklistId = z
  .string()
  .regex(/^CL-\d{3}$/, "checklist id must look like CL-001");

export const LinkId = z
  .string()
  .regex(/^L-\d{3}$/, "link id must look like L-001");

export const MilestoneId = z
  .string()
  .regex(/^M\d{1,2}$/, "milestone id must look like M1");

export const SourceId = z
  .string()
  .regex(/^S-\d{3}$/, "sync source id must look like S-001");

export const Slug = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case using a-z0-9 only");

/**
 * YAML 1.1 会把无引号的 `2026-07-28` 自动解析成 JS Date。
 * 要求人和 Copilot 在 front matter 里给日期加引号既不直观也容易忘,
 * 所以在 schema 层统一归一化为字符串。JSON 里本来就没有 Date 类型,不受影响。
 */
function dateLike<T extends z.ZodTypeAny>(schema: T, dateOnly: boolean) {
  return z.preprocess((value) => {
    if (value instanceof Date) {
      const iso = value.toISOString();
      return dateOnly ? iso.slice(0, 10) : iso;
    }
    return value;
  }, schema);
}

/** 日期一律 YYYY-MM-DD(本机时区)。 */
export const IsoDate = dateLike(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  true,
);

/** 时间戳一律 ISO 8601 带偏移,例如 2026-07-28T09:12:00+08:00。 */
export const IsoDateTime = dateLike(
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      "timestamp must be ISO 8601 with a timezone offset",
    ),
  false,
);

export const MemberId = z.string().min(1).max(64);
export const SprintId = z.string().min(1).max(32);
export const Tag = z.string().min(1).max(32);

/**
 * 自由书写的备注。
 *
 * 上限的职责只有一个:挡住把整篇文档粘进 JSON 字段这种病态输入。
 * **不是**用来管人怎么写句子的 —— front matter 不合法是 error 级,
 * 会让 validate 失败并被 pre-commit 挡下。让人在正常书写时撞到上限、
 * 结果提交被拒,这个交换比不成立。
 *
 * title 之类有版面约束的字段仍然保持紧的上限,那里的限制是有意义的。
 */
export const Note = z.string().max(2000);

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

export const TaskType = z.enum([
  "feature",
  "bug",
  "chore",
  "spike",
  "doc",
  "ops",
]);

/** 见 Design §4.2 状态机。 */
export const TaskStatus = z.enum([
  "backlog",
  "analyzing",
  "designing",
  "ready",
  "in-progress",
  "in-review",
  "blocked",
  "done",
  "dropped",
]);

/** 终态:进度上卷与依赖满足判定都以此为准。 */
export const TERMINAL_STATUSES = ["done", "dropped"] as const;

export const Priority = z.enum(["P0", "P1", "P2", "P3"]);
export const Size = z.enum(["XS", "S", "M", "L", "XL"]);

/** 从属层级。rank 由 config.levels 定义,默认 epic<feature<story<task<subtask。 */
export const Level = z.enum(["epic", "feature", "story", "task", "subtask"]);

/** 当前由谁推进。 */
export const Driver = z.enum(["human", "copilot", "pair"]);

/** 依赖类型。v1 只有 FS / SS 参与排期推算(Q7)。 */
export const DependencyType = z.enum([
  "finish-to-start",
  "start-to-start",
  "finish-to-finish",
  "start-to-finish",
]);

/** 生命周期文档的推进状态。 */
export const DocState = z.enum([
  "todo",
  "in-progress",
  "done",
  "ongoing",
  "skipped",
]);

/** 设计文档状态。被替代的方案标 superseded 且保留不删(DD-6)。 */
export const DesignState = z.enum([
  "draft",
  "in-review",
  "accepted",
  "superseded",
  "rejected",
]);

export const LinkKind = z.enum([
  "ado",
  "pr",
  "code",
  "teams",
  "outlook",
  "doc",
  "design",
  "dashboard",
  "other",
]);

export const SyncSourceKind = z.enum([
  "teams",
  "outlook",
  "ado",
  "pr",
  "code",
  "calendar",
]);

export const CopilotHandoff = z.enum([
  "none",
  "ready",
  "running",
  "needs-human",
  "done",
]);

export const CopilotPhase = z.enum([
  "analyze",
  "plan",
  "design",
  "implement",
  "verify",
]);

/** 接管时自动拼入多少上下文,见 Design §7.12。 */
export const ContextScope = z.enum(["self", "ancestors", "ancestors+deps"]);

export const ProgressMode = z.enum(["checklist", "rollup", "manual"]);

export const MilestoneState = z.enum(["todo", "doing", "done", "skipped"]);

export const VerifyMethod = z.enum([
  "manual",
  "unit",
  "e2e",
  "ci",
  "review",
]);

// ---------------------------------------------------------------------------
// 校验问题(issue codes,见 Design §7.8)
// ---------------------------------------------------------------------------

export const IssueCode = z.enum([
  // 结构 / 关系
  "ORPHAN_PARENT",
  "DANGLING_DEP",
  "SELF_REFERENCE",
  "CYCLE_HIERARCHY",
  "CYCLE_DEPENDENCY",
  "LEVEL_INVERSION",
  "PARENT_DONE_EARLY",
  "DEPTH_EXCEEDED",
  "DEP_ON_RELATIVE",
  "DEP_VIOLATION",
  "ROLLUP_MISMATCH",
  "SCHEDULE_CONFLICT",
  // 文件 / 格式
  "SCHEMA_INVALID",
  "DIR_NAME_MISMATCH",
  "DUPLICATE_ID",
  "MISSING_DOC",
  "FRONTMATTER_INVALID",
  "DUPLICATE_CHECKLIST_ID",
  "DANGLING_CHECKLIST_REF",
  "DANGLING_MENTION",
]);

export const IssueSeverity = z.enum(["error", "warn", "info"]);

export const Issue = z.object({
  code: IssueCode,
  severity: IssueSeverity,
  taskId: TaskId.optional(),
  path: z.string().optional(),
  message: z.string(),
  related: z.array(z.string()).optional(),
});

export type Issue = z.infer<typeof Issue>;
export type IssueCode = z.infer<typeof IssueCode>;
export type IssueSeverity = z.infer<typeof IssueSeverity>;

/** 每个 issue code 的默认级别。校验器与 UI 共用。 */
export const ISSUE_SEVERITY: Record<IssueCode, IssueSeverity> = {
  ORPHAN_PARENT: "error",
  DANGLING_DEP: "error",
  SELF_REFERENCE: "error",
  CYCLE_HIERARCHY: "error",
  CYCLE_DEPENDENCY: "error",
  LEVEL_INVERSION: "error",
  PARENT_DONE_EARLY: "error",
  DEPTH_EXCEEDED: "warn",
  DEP_ON_RELATIVE: "warn",
  DEP_VIOLATION: "warn",
  ROLLUP_MISMATCH: "info",
  SCHEDULE_CONFLICT: "info",
  SCHEMA_INVALID: "error",
  DIR_NAME_MISMATCH: "error",
  DUPLICATE_ID: "error",
  MISSING_DOC: "warn",
  FRONTMATTER_INVALID: "error",
  DUPLICATE_CHECKLIST_ID: "error",
  DANGLING_CHECKLIST_REF: "warn",
  DANGLING_MENTION: "info",
};

export function issue(
  code: IssueCode,
  message: string,
  extra: Omit<Issue, "code" | "severity" | "message"> = {},
): Issue {
  return { code, severity: ISSUE_SEVERITY[code], message, ...extra };
}
