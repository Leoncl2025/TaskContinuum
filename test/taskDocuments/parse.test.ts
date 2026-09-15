// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { IsoDate, IsoDateTime } from "../../src/shared/taskDocuments/common.js";
import {
  ChecklistFrontMatter,
  checklistPercent,
  parseChecklist,
  parseMentions,
} from "../../src/shared/taskDocuments/frontmatter.js";

describe("parseChecklist", () => {
  it("reads id, state, text and metadata", () => {
    const { items } = parseChecklist(
      "- [x] `CL-001` Board renders <!-- owner:lianc verify:e2e milestone:M2 -->",
    );
    assert.equal(items.length, 1);
    assert.deepEqual(
      { ...items[0] },
      {
        id: "CL-001",
        checked: true,
        text: "Board renders",
        owner: "lianc",
        verify: "e2e",
        milestone: "M2",
        line: 1,
      },
    );
  });

  it("accepts both [x] and [X]", () => {
    const { items } = parseChecklist("- [X] `CL-001` upper");
    assert.equal(items[0]!.checked, true);
  });

  it("reports the 1-based line number so the writer can flip one character", () => {
    const { items } = parseChecklist(
      ["# Heading", "", "- [ ] `CL-001` first", "- [ ] `CL-002` second"].join("\n"),
    );
    assert.deepEqual(
      items.map((i) => i.line),
      [3, 4],
    );
  });

  it("ignores lines that only look like checklist items", () => {
    const body = [
      "- [ ] no id at all",
      "- [ ] `CL-1` id too short",
      "- [ ] `T-0001` wrong prefix",
      "  * [ ] `CL-001` wrong bullet",
      "- [?] `CL-002` bad mark",
      "- [ ] `CL-003` genuinely valid",
    ].join("\n");
    const { items } = parseChecklist(body);
    assert.deepEqual(
      items.map((i) => i.id),
      ["CL-003"],
    );
  });

  it("survives an indented item", () => {
    const { items } = parseChecklist("    - [ ] `CL-007` nested under something");
    assert.deepEqual(
      items.map((i) => i.id),
      ["CL-007"],
    );
  });

  it("drops an unrecognised verify method rather than inventing one", () => {
    const { items } = parseChecklist("- [ ] `CL-001` x <!-- verify:vibes -->");
    assert.equal(items[0]!.verify, undefined);
  });

  it("reports duplicate ids — reusing one silently would corrupt progress", () => {
    const { items, duplicates } = parseChecklist(
      ["- [x] `CL-001` first", "- [ ] `CL-001` same id again"].join("\n"),
    );
    assert.deepEqual(duplicates, ["CL-001"]);
    // 两条都要保留,校验器负责报错,解析器不许私自丢数据
    assert.equal(items.length, 2);
  });
});

describe("checklistPercent", () => {
  it("returns 0 for an empty checklist instead of NaN", () => {
    assert.equal(checklistPercent([]), 0);
  });

  it("rounds to the nearest whole percent", () => {
    const items = [true, false, false].map((checked, i) => ({
      id: `CL-00${i + 1}`,
      checked,
      text: "x",
      line: i + 1,
    }));
    assert.equal(checklistPercent(items), 33);
  });
});

describe("parseMentions", () => {
  it("extracts [[T-XXXX]] and de-duplicates", () => {
    assert.deepEqual(
      parseMentions("see [[T-0004]] and [[T-0002]], also [[T-0004]] again"),
      ["T-0004", "T-0002"],
    );
  });

  it("ignores malformed references", () => {
    assert.deepEqual(parseMentions("[[T-4]] [T-0004] [[t-0004]] [[T-00041]]"), []);
  });
});

describe("date coercion", () => {
  /**
   * YAML 会把不带引号的 2026-07-28 直接解析成 JS Date 对象。
   * 之前这一条让整个工作区报了 28 个校验错误 —— 所以这里必须锁死。
   */
  it("accepts a Date object from YAML and normalises it to YYYY-MM-DD", () => {
    assert.equal(IsoDate.parse(new Date("2026-07-28T00:00:00Z")), "2026-07-28");
  });

  it("still accepts a plain string", () => {
    assert.equal(IsoDate.parse("2026-07-28"), "2026-07-28");
  });

  it("rejects a timestamp where a date is expected", () => {
    assert.equal(IsoDate.safeParse("2026-07-28T09:00:00+08:00").success, false);
  });

  it("requires a timezone offset on timestamps", () => {
    assert.equal(IsoDateTime.safeParse("2026-07-28T09:00:00").success, false);
    assert.equal(IsoDateTime.safeParse("2026-07-28T09:00:00+08:00").success, true);
    assert.equal(IsoDateTime.safeParse("2026-07-28T01:00:00Z").success, true);
  });
});

describe("front matter schemas", () => {
  it("rejects a document whose doc kind does not match", () => {
    assert.equal(
      ChecklistFrontMatter.safeParse({
        doc: "plan",
        taskId: "T-0001",
        updated: "2026-07-28",
        authors: ["lianc"],
      }).success,
      false,
    );
  });

  it("accepts a Date in the updated field, as YAML would produce", () => {
    const parsed = ChecklistFrontMatter.parse({
      doc: "checklist",
      taskId: "T-0001",
      updated: new Date("2026-07-28T00:00:00Z"),
      authors: ["lianc"],
    });
    assert.equal(parsed.updated, "2026-07-28");
  });
});
