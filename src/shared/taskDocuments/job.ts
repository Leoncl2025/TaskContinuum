// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod/v3";
import {
  IsoDateTime,
  JobId,
  MemberId,
  SyncSourceKind,
  TaskId,
} from "./common.js";
import { Suggestion } from "./task.js";

/**
 * 作业 = 一个 json 文件(Design §12.4)。
 * 它同时是队列、协议与审计记录:Web 写 input/policy,Copilot 写 claim/result。
 * 没有 RPC —— 双方都只是改这一个文件(DD-17)。
 */

export const JobType = z.enum([
  "sync-context",
  "handoff",
  "plan",
  "design",
  "verify",
  "triage",
]);

export const JobStatus = z.enum([
  "queued",
  "running",
  "review",
  "applied",
  "discarded",
  "failed",
  "expired",
]);

export const JobTrigger = z.enum([
  "ui-latest-button",
  "ui-handoff-button",
  "cli",
  "scheduled",
]);

export const FindingKind = z.enum([
  "background",
  "status",
  "direction",
  "people",
]);

export const Finding = z.object({
  kind: FindingKind,
  text: z.string().min(1).max(500),
  /** 必须能回溯到原文出处:ref 文件行号或链接 id。 */
  evidence: z.array(z.string()).min(1),
});

export const JobPolicy = z.object({
  /** 边界声明。安全强制发生在闸门 G1–G6,这里只是引导(DD-18)。 */
  allowedPaths: z.array(z.string()).default([]),
  taskJsonFields: z.array(z.string()).default([]),
  forbid: z.array(z.string()).default([]),
  maxWriteBytes: z.number().int().positive().default(262144),
  requireCleanWorktree: z.boolean().default(true),
  autoApply: z.literal(false).default(false),
});

export const JobInput = z.object({
  sources: z.array(SyncSourceKind).default([]),
  since: z.record(z.string()).default({}),
  goal: z.string().max(500),
});

export const JobResult = z.object({
  summary: z.string().max(1000),
  findings: z.array(Finding).default([]),
  suggestions: z.array(Suggestion).default([]),
  /** 服务端会独立比对实际 git diff,不一致则告警(G3)。 */
  changedFiles: z.array(z.string()).default([]),
  /** Copilot 自报的可疑内容;server 会再独立扫一遍。 */
  suspicious: z.array(z.string()).default([]),
  newCursors: z.record(z.string()).default({}),
});

export const Job = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.string(),
    id: JobId,
    type: JobType,
    taskId: TaskId,
    createdAt: IsoDateTime,
    createdBy: MemberId,
    trigger: JobTrigger,

    status: JobStatus,
    expiresAt: IsoDateTime,

    input: JobInput,
    policy: JobPolicy,

    claim: z
      .object({
        by: MemberId,
        at: IsoDateTime,
        session: z.string().max(60).optional(),
      })
      .nullable()
      .default(null),

    result: JobResult.nullable().default(null),
  })
  .superRefine((job, ctx) => {
    if (["running", "review"].includes(job.status) && !job.claim) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: `claim is required when status is ${job.status}`,
      });
    }
    if (["review", "applied"].includes(job.status) && !job.result) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: `result is required when status is ${job.status}`,
      });
    }
  });

export type Job = z.infer<typeof Job>;
export type JobResult = z.infer<typeof JobResult>;
export type Finding = z.infer<typeof Finding>;

/** 允许的状态迁移。 */
export const JOB_TRANSITIONS: Record<string, string[]> = {
  queued: ["running", "expired", "discarded", "failed"],
  running: ["review", "failed", "expired"],
  review: ["applied", "discarded"],
  applied: [],
  discarded: [],
  failed: [],
  expired: [],
};
