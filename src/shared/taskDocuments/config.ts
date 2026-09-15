// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";
import {
  DependencyType,
  IsoDate,
  Level,
  MemberId,
  SprintId,
  Tag,
  TaskStatus,
} from "./common.js";

export const LevelDef = z.object({
  id: Level,
  rank: z.number().int().min(0).max(9),
  title: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const ColumnDef = z.object({
  id: z.string().min(1).max(32),
  title: z.string().min(1).max(40),
  statuses: z.array(TaskStatus).min(1),
  /** 在制品上限,超出时列头变红。 */
  wip: z.number().int().positive().optional(),
  collapsed: z.boolean().default(false),
});

export const SprintDef = z.object({
  id: SprintId,
  title: z.string().min(1).max(60),
  start: IsoDate,
  end: IsoDate,
  current: z.boolean().default(false),
});

export const MemberDef = z.object({
  id: MemberId,
  name: z.string().min(1).max(60),
  kind: z.enum(["human", "agent"]).default("human"),
});

export const HierarchyConfig = z.object({
  maxDepth: z.number().int().min(1).max(10).default(5),
  /** true = 父子 rank 必须恰好差 1。 */
  strictLevelStep: z.boolean().default(false),
  /** 看板默认展示哪些层级,其余层级去 Backlog 树看。 */
  boardLevels: z.array(Level).default(["story", "task"]),
  rollup: z
    .object({
      includeSelf: z.boolean().default(true),
      sizeWeight: z.record(z.number().positive()).default({
        XS: 1,
        S: 2,
        M: 3,
        L: 5,
        XL: 8,
      }),
    })
    .default({}),
});

export const DependencyConfig = z.object({
  defaultType: DependencyType.default("finish-to-start"),
  defaultHard: z.boolean().default(true),
  /** 只提建议,不自动改 status(DD-11 / §12.7)。 */
  autoBlockSuggestion: z.boolean().default(true),
  warnOnRelativeDep: z.boolean().default(true),
});

export const GitConfig = z.object({
  branchPattern: z.string().default("task/{id}-{slug}"),
  commitPattern: z.string().default("{id}({scope}): {subject}"),
});

export const JobsConfig = z.object({
  dir: z.string().default(".agentdesk/jobs"),
  ttlMinutes: z.number().int().positive().default(60),
  maxConcurrent: z.number().int().positive().default(1),
  requireCleanWorktree: z.boolean().default(true),
  /** 恒为 false:任何同步都必须人工审阅(SEC-4 / G1)。 */
  autoApply: z.literal(false).default(false),
  retainDays: z.number().int().positive().default(90),
});

/** 落地闸门 G1–G6,见 Design §12.9。护栏建在这里,不建在工具层(DD-18)。 */
export const GatesConfig = z.object({
  validate: z.boolean().default(true), // G2
  scopeCheck: z.boolean().default(true), // G3
  injectionScan: z.boolean().default(true), // G4
  secretScan: z.boolean().default(true), // G4
  preCommitHook: z.boolean().default(true), // G5
});

export const BridgeConfig = z.object({
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(4711),
  requireOrigin: z.boolean().default(true),
  /** 可选的只读加速层,非数据通道前提(DD-17)。 */
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      readOnly: z.literal(true).default(true),
      transport: z.enum(["stdio", "http"]).default("stdio"),
      serverName: z.string().default("agentdesk"),
    })
    .default({}),
  vscodeExtension: z
    .object({
      enabled: z.boolean().default(true),
      autoInject: z.boolean().default(false),
      uriScheme: z.string().default("vscode://agentdesk.agentdesk"),
    })
    .default({}),
  jobs: JobsConfig.default({}),
  gates: GatesConfig.default({}),
  sync: z
    .object({
      defaultSources: z.array(z.string()).default(["teams", "outlook", "ado", "pr"]),
      advanceCursorOnAcceptOnly: z.literal(true).default(true),
    })
    .default({}),
});

export const PathsConfig = z.object({
  tasks: z.string().default("tasks"),
  archive: z.string().default("archive"),
  templates: z.string().default("templates/task"),
});

export const Config = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.string(),
    workspace: z.string().min(1).max(60),
    taskIdPrefix: z.string().default("T-"),
    taskIdWidth: z.number().int().min(3).max(6).default(4),
    levels: z.array(LevelDef).min(1),
    hierarchy: HierarchyConfig.default({}),
    dependency: DependencyConfig.default({}),
    columns: z.array(ColumnDef).min(1),
    sprints: z.array(SprintDef).default([]),
    members: z.array(MemberDef).min(1),
    tags: z.array(Tag).default([]),
    git: GitConfig.default({}),
    bridge: BridgeConfig.default({}),
    paths: PathsConfig.default({}),
  })
  .superRefine((cfg, ctx) => {
    const ranks = new Set<number>();
    for (const lv of cfg.levels) {
      if (ranks.has(lv.rank)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["levels"],
          message: `duplicate level rank ${lv.rank}`,
        });
      }
      ranks.add(lv.rank);
    }
    const currentSprints = cfg.sprints.filter((s) => s.current);
    if (currentSprints.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sprints"],
        message: `only one sprint may be marked current, found ${currentSprints.length}`,
      });
    }
    const covered = new Set(cfg.columns.flatMap((c) => c.statuses));
    for (const status of TaskStatus.options) {
      if (!covered.has(status)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns"],
          message: `status "${status}" is not covered by any board column, its cards would disappear`,
        });
      }
    }
  });

export type Config = z.infer<typeof Config>;

/** level id → rank 的查表。 */
export function levelRanks(config: Config): Record<string, number> {
  return Object.fromEntries(config.levels.map((l) => [l.id, l.rank]));
}
