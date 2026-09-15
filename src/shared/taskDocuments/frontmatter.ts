// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";
import {
  ChecklistId,
  DesignId,
  DesignState,
  DocState,
  IsoDate,
  LinkId,
  LinkKind,
  MemberId,
  MilestoneId,
  MilestoneState,
  Note,
  TaskId,
  VerifyMethod,
} from "./common.js";

/**
 * 生命周期 md 的 front matter schema(Design §5)。
 * front matter 是 md 与 json 之间的桥:既在 md 里(Copilot 顺手读到),又结构化(程序可解析)。
 */

const Base = {
  taskId: TaskId.optional(),
  project: z.string().optional(),
  updated: IsoDate,
  authors: z.array(MemberId).default([]),
};

export const RequirementFrontMatter = z.object({
  doc: z.literal("requirement-analysis"),
  state: DocState.default("in-progress"),
  /** 需求来源:ref 文件路径或链接 id。 */
  source: z.array(z.string()).default([]),
  ...Base,
});

export const Milestone = z.object({
  id: MilestoneId,
  title: z.string().min(1).max(80),
  start: IsoDate,
  due: IsoDate,
  state: MilestoneState,
  checklist: z.array(ChecklistId).default([]),
});

export const PlanFrontMatter = z.object({
  doc: z.literal("plan"),
  state: DocState.default("in-progress"),
  milestones: z.array(Milestone).default([]),
  ...Base,
});

export const DesignFrontMatter = z.object({
  doc: z.literal("design"),
  id: DesignId,
  title: z.string().min(1).max(120),
  state: DesignState,
  supersedes: DesignId.nullable().default(null),
  decision: z.string().max(500).optional(),
  alternatives: z.array(z.string()).default([]),
  ...Base,
});

export const ChecklistFrontMatter = z.object({
  doc: z.literal("checklist"),
  ...Base,
});

export const Link = z.object({
  id: LinkId,
  kind: LinkKind,
  title: z.string().min(1).max(160),
  url: z.string().min(1),
  note: Note.optional(),
  /** 置顶链接会显示在看板卡片上,最多 3 个。 */
  pinned: z.boolean().default(false),
  state: z
    .enum(["todo", "active", "merged", "abandoned", "closed"])
    .optional(),
});

export const ReferenceFrontMatter = z.object({
  doc: z.literal("reference"),
  links: z.array(Link).default([]),
  ...Base,
});

export type Link = z.infer<typeof Link>;
export type Milestone = z.infer<typeof Milestone>;

export const FRONT_MATTER_SCHEMAS = {
  "requirement-analysis": RequirementFrontMatter,
  plan: PlanFrontMatter,
  design: DesignFrontMatter,
  checklist: ChecklistFrontMatter,
  reference: ReferenceFrontMatter,
} as const;

// ---------------------------------------------------------------------------
// Checklist 解析(Design §5.4)
//
//   - [x] `CL-001` 描述 <!-- owner:copilot verify:e2e milestone:M2 -->
//
// 勾选状态的唯一所有者是 md;task.json 的进度由此推导(DD-3)。
// ---------------------------------------------------------------------------

const CHECKLIST_LINE =
  /^\s*-\s+\[( |x|X)\]\s+`(CL-\d{3})`\s+(.+?)(?:\s*<!--(.*?)-->)?\s*$/;

export interface ChecklistItem {
  id: string;
  checked: boolean;
  text: string;
  owner?: string;
  verify?: z.infer<typeof VerifyMethod>;
  milestone?: string;
  /** 1-based 行号,便于 UI 精确改写单个字符。 */
  line: number;
}

export function parseChecklist(body: string): {
  items: ChecklistItem[];
  duplicates: string[];
} {
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  body.split(/\r?\n/).forEach((raw, i) => {
    const m = CHECKLIST_LINE.exec(raw);
    if (!m) return;
    const [, mark, id, text, meta] = m;
    if (!id || !mark || !text) return;
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);

    const item: ChecklistItem = {
      id,
      checked: mark.toLowerCase() === "x",
      text: text.trim(),
      line: i + 1,
    };
    for (const [key, value] of parseMeta(meta)) {
      if (key === "owner") item.owner = value;
      else if (key === "milestone") item.milestone = value;
      else if (key === "verify") {
        const parsed = VerifyMethod.safeParse(value);
        if (parsed.success) item.verify = parsed.data;
      }
    }
    items.push(item);
  });

  return { items, duplicates };
}

function parseMeta(meta: string | undefined): [string, string][] {
  if (!meta) return [];
  return [...meta.matchAll(/(\w+):([^\s]+)/g)].map((m) => [m[1]!, m[2]!]);
}

/** 进度推导:passed / total(Design §6)。total=0 时为 0。 */
export function checklistPercent(items: ChecklistItem[]): number {
  if (items.length === 0) return 0;
  const passed = items.filter((i) => i.checked).length;
  return Math.round((passed / items.length) * 100);
}

// ---------------------------------------------------------------------------
// 跨任务引用 [[T-0011]](Design §7.9)—— 只做导航,不构成依赖
// ---------------------------------------------------------------------------

export function parseMentions(body: string): string[] {
  const ids = [...body.matchAll(/\[\[(T-\d{4})\]\]/g)].map((m) => m[1]!);
  return [...new Set(ids)];
}

export { TaskId };
