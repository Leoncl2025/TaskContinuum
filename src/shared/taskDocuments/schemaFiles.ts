// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod/v3";
import { Config } from "./config.js";
import { IndexFile } from "./indexFile.js";
import { Job } from "./job.js";
import { Task } from "./task.js";

/**
 * JSON Schema 的唯一产出口。
 * `agentdesk init` 与 `npm run schema:gen` 共用它,避免两处渲染逻辑漂移。
 */

export const SCHEMA_TARGETS: { file: string; schema: ZodTypeAny; name: string }[] = [
  { file: "task.schema.json", schema: Task, name: "Task" },
  { file: "config.schema.json", schema: Config, name: "Config" },
  { file: "index.schema.json", schema: IndexFile, name: "IndexFile" },
  { file: "job.schema.json", schema: Job, name: "Job" },
];

export function renderSchema(schema: ZodTypeAny, name: string): string {
  const json = zodToJsonSchema(schema, {
    name,
    $refStrategy: "root",
    target: "jsonSchema2019-09",
  });
  return `${JSON.stringify(json, null, 2)}\n`;
}

export function renderAllSchemas(): { file: string; content: string }[] {
  return SCHEMA_TARGETS.map((t) => ({
    file: t.file,
    content: renderSchema(t.schema, t.name),
  }));
}
