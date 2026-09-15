// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildGraph } from "../../src/main/taskDocuments/graph.js";
import { codes, makeWorkspace } from "./fixtures.js";

describe("buildGraph - calendar arithmetic guards", () => {
  it("reports schema-accepted invalid dates without losing unrelated diagnostics", () => {
    for (const due of ["2026-13-01", "2026-02-30"]) {
      const ws = makeWorkspace([
        { id: "T-0001", due },
        { id: "T-0002", dependsOn: [{ id: "T-0001" }] },
        { id: "T-0003", parent: "T-9999" },
      ]);
      const graph = buildGraph(ws);
      assert.ok(graph.issues.some((issue) => issue.code === "SCHEMA_INVALID" && issue.taskId === "T-0001"));
      assert.ok(graph.issues.some((issue) => issue.code === "ORPHAN_PARENT" && issue.taskId === "T-0003"));
      assert.equal(graph.relations.get("T-0002")?.earliestStart, null);
      assert.equal(graph.relations.get("T-0001")?.rolledDue, null);
      assert.equal(graph.relations.size, 3);
      assert.equal(ws.tasks[0].task.dates.due, due);
    }
  });

  it("reports overflowing positive and negative dependency lags and retains valid alternatives", () => {
    for (const lag of [1e100, Number.MAX_SAFE_INTEGER, 1e9, -1e9]) {
      const graph = buildGraph(makeWorkspace([
        { id: "T-0001", due: "2026-09-14" },
        { id: "T-0002", due: "2026-09-15" },
        { id: "T-0003", dependsOn: [{ id: "T-0001", lag }, { id: "T-0002" }] },
        { id: "T-0004", parent: "T-9999" },
      ]));
      assert.ok(graph.issues.some((issue) => issue.code === "SCHEMA_INVALID" && issue.taskId === "T-0003" && issue.related?.includes("T-0001")));
      assert.ok(codes(graph.issues).includes("ORPHAN_PARENT"));
      assert.equal(graph.relations.get("T-0003")?.earliestStart, "2026-09-16");
      assert.equal(graph.relations.size, 4);
    }
  });

  it("guards invalid start dates and preserves valid leap-day arithmetic", () => {
    const graph = buildGraph(makeWorkspace([
      { id: "T-0001", started: "2026-02-30" },
      { id: "T-0002", dependsOn: [{ id: "T-0001", type: "start-to-start" }] },
      { id: "T-0003", due: "2028-02-28" },
      { id: "T-0004", dependsOn: [{ id: "T-0003" }] },
    ]));
    assert.ok(graph.issues.some((issue) => issue.code === "SCHEMA_INVALID" && issue.taskId === "T-0001"));
    assert.equal(graph.relations.get("T-0002")?.earliestStart, null);
    assert.equal(graph.relations.get("T-0004")?.earliestStart, "2028-02-29");
  });
});

/**
 * 图引擎。NFR-10 的硬要求是:**任何环、孤儿、层级倒置都不得导致崩溃或无限递归**。
 * 所以这里每个畸形输入的用例都同时断言两件事:没挂,而且报出了正确的 issue。
 */

describe("buildGraph — hierarchy", () => {
  it("derives children, ancestors and depth from the one-way parent edge", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic" },
        { id: "T-0002", level: "feature", parent: "T-0001" },
        { id: "T-0003", level: "task", parent: "T-0002" },
      ]),
    );

    assert.deepEqual(g.relations.get("T-0001")!.children, ["T-0002"]);
    assert.deepEqual(g.relations.get("T-0003")!.ancestors, ["T-0001", "T-0002"]);
    assert.equal(g.relations.get("T-0003")!.depth, 2);
    assert.equal(g.relations.get("T-0001")!.descendantCount, 2);
    assert.deepEqual(g.roots, ["T-0001"]);
  });

  it("survives a parent cycle instead of recursing forever", () => {
    // A -> B -> C -> A。递归实现会栈溢出,这里必须报错并把环打断。
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic", parent: "T-0003" },
        { id: "T-0002", level: "feature", parent: "T-0001" },
        { id: "T-0003", level: "story", parent: "T-0002" },
      ]),
    );

    assert.ok(codes(g.issues).includes("CYCLE_HIERARCHY"));
    assert.ok(g.cycles.length > 0);
    // 环被打断后,三个任务仍然都要拿到 relations,不能有谁人间蒸发
    for (const id of ["T-0001", "T-0002", "T-0003"]) {
      assert.ok(g.relations.has(id), `${id} lost its relations`);
    }
  });

  it("flags a task that is its own parent", () => {
    // superRefine 会挡住 task.json 里的自环,但索引器仍要能扛住手工构造的数据
    const ws = makeWorkspace([{ id: "T-0001", level: "epic" }]);
    ws.tasks[0]!.task.relations.parent = "T-0001";
    const g = buildGraph(ws);
    assert.ok(codes(g.issues).includes("SELF_REFERENCE"));
  });

  it("flags a parent that does not exist", () => {
    const g = buildGraph(
      makeWorkspace([{ id: "T-0002", level: "feature", parent: "T-0099" }]),
    );
    assert.ok(codes(g.issues).includes("ORPHAN_PARENT"));
    // 孤儿仍然要出现在 roots 里,否则树上就看不见它了
    assert.deepEqual(g.roots, ["T-0002"]);
  });

  it("flags level inversion", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "task" },
        { id: "T-0002", level: "epic", parent: "T-0001" },
      ]),
    );
    assert.ok(codes(g.issues).includes("LEVEL_INVERSION"));
  });

  it("only complains about skipped ranks when strictLevelStep is on", () => {
    const specs = [
      { id: "T-0001", level: "epic" },
      { id: "T-0002", level: "task", parent: "T-0001" },
    ];
    assert.ok(!codes(buildGraph(makeWorkspace(specs)).issues).includes("LEVEL_INVERSION"));

    const strict = buildGraph(
      makeWorkspace(specs, { hierarchy: { strictLevelStep: true } }),
    );
    assert.ok(codes(strict.issues).includes("LEVEL_INVERSION"));
  });
});

describe("buildGraph — dependencies", () => {
  it("derives blocks and blockedBy from the one-way dependsOn edge", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001" },
        { id: "T-0002", dependsOn: [{ id: "T-0001" }] },
      ]),
    );

    assert.deepEqual(g.relations.get("T-0001")!.blocks, ["T-0002"]);
    assert.deepEqual(g.relations.get("T-0002")!.blockedBy, ["T-0001"]);
    assert.equal(g.relations.get("T-0002")!.readyToStart, false);
    assert.equal(g.relations.get("T-0001")!.readyToStart, true);
  });

  it("stops blocking once the predecessor reaches a terminal status", () => {
    for (const status of ["done", "dropped"]) {
      const g = buildGraph(
        makeWorkspace([
          { id: "T-0001", status },
          { id: "T-0002", dependsOn: [{ id: "T-0001" }] },
        ]),
      );
      assert.deepEqual(
        g.relations.get("T-0002")!.blockedBy,
        [],
        `${status} should not block`,
      );
    }
  });

  it("treats soft dependencies as advisory only", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001" },
        { id: "T-0002", dependsOn: [{ id: "T-0001", hard: false }] },
      ]),
    );
    assert.deepEqual(g.relations.get("T-0002")!.blockedBy, []);
    assert.equal(g.relations.get("T-0002")!.readyToStart, true);
  });

  it("survives a dependency cycle", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", dependsOn: [{ id: "T-0002" }] },
        { id: "T-0002", dependsOn: [{ id: "T-0001" }] },
      ]),
    );
    assert.ok(codes(g.issues).includes("CYCLE_DEPENDENCY"));
    // 环上的节点排不进拓扑序,这正是我们判断"有环"的依据
    assert.equal(g.topoOrder.length, 0);
  });

  it("flags a dependency on a task that does not exist", () => {
    const g = buildGraph(makeWorkspace([{ id: "T-0001", dependsOn: [{ id: "T-0099" }] }]));
    assert.ok(codes(g.issues).includes("DANGLING_DEP"));
  });

  it("warns when in-progress work is actually blocked", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001" },
        { id: "T-0002", status: "in-progress", dependsOn: [{ id: "T-0001" }] },
      ]),
    );
    assert.ok(codes(g.issues).includes("DEP_VIOLATION"));
  });
});

describe("buildGraph — progress roll-up", () => {
  it("uses the checklist directly for a leaf", () => {
    const g = buildGraph(makeWorkspace([{ id: "T-0001", checked: 3, total: 4 }]));
    assert.equal(g.percent.get("T-0001"), 75);
    assert.deepEqual(g.checklist.get("T-0001"), { passed: 3, total: 4 });
  });

  it("weights children by size rather than counting them equally", () => {
    // S=2 at 100%, L=5 at 0%  ->  (2*100 + 5*0) / 7 = 29%,不是简单平均的 50%
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic" },
        { id: "T-0002", level: "feature", parent: "T-0001", size: "S", checked: 2, total: 2 },
        { id: "T-0003", level: "feature", parent: "T-0001", size: "L", checked: 0, total: 4 },
      ]),
    );
    assert.equal(g.percent.get("T-0001"), 29);
  });

  it("prefers estimateHours over size when both are present", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic" },
        {
          id: "T-0002",
          level: "feature",
          parent: "T-0001",
          size: "XS",
          estimateHours: 9,
          checked: 1,
          total: 1,
        },
        { id: "T-0003", level: "feature", parent: "T-0001", estimateHours: 1, total: 1 },
      ]),
    );
    // 9*100 + 1*0 = 900 / 10 = 90。若用了 size XS(=1) 会得到 50。
    assert.equal(g.percent.get("T-0001"), 90);
  });

  it("does not let a parent's own checklist count when it has none", () => {
    // rollupIncludeSelf 默认 true,但父任务 0 条 checklist 时不应凭空插入一个 0%
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic", total: 0 },
        { id: "T-0002", level: "feature", parent: "T-0001", checked: 2, total: 2 },
      ]),
    );
    assert.equal(g.percent.get("T-0001"), 100);
  });

  it("honours manual progress and flags a large divergence", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic", progressMode: "manual", manualPercent: 90 },
        { id: "T-0002", level: "feature", parent: "T-0001", checked: 0, total: 4 },
      ]),
    );
    assert.equal(g.percent.get("T-0001"), 90);
    assert.equal(g.relations.get("T-0001")!.rollupPercent, 0);
    assert.ok(codes(g.issues).includes("ROLLUP_MISMATCH"));
  });

  it("flags a parent marked done while children are still open", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic", status: "done" },
        { id: "T-0002", level: "feature", parent: "T-0001", status: "in-progress" },
      ]),
    );
    assert.ok(codes(g.issues).includes("PARENT_DONE_EARLY"));
  });
});

describe("buildGraph — scheduling", () => {
  it("picks the longest weighted chain as the critical path", () => {
    //  T-0001(1) -> T-0002(8)      total 9
    //  T-0003(1) -> T-0004(2)      total 3
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", size: "XS" },
        { id: "T-0002", size: "XL", dependsOn: [{ id: "T-0001" }] },
        { id: "T-0003", size: "XS" },
        { id: "T-0004", size: "S", dependsOn: [{ id: "T-0003" }] },
      ]),
    );
    assert.deepEqual(g.criticalPath, ["T-0001", "T-0002"]);
    assert.equal(g.relations.get("T-0002")!.onCriticalPath, true);
    assert.equal(g.relations.get("T-0004")!.onCriticalPath, false);
  });

  it("reports no critical path when nothing depends on anything", () => {
    const g = buildGraph(makeWorkspace([{ id: "T-0001", size: "XL" }, { id: "T-0002" }]));
    assert.deepEqual(g.criticalPath, []);
  });

  it("computes earliestStart for finish-to-start with lag", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", due: "2026-03-10" },
        { id: "T-0002", dependsOn: [{ id: "T-0001", lag: 2 }] },
      ]),
    );
    // FS: 前驱 due + lag + 1 天
    assert.equal(g.relations.get("T-0002")!.earliestStart, "2026-03-13");
  });

  it("computes earliestStart for start-to-start", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", started: "2026-03-10" },
        {
          id: "T-0002",
          dependsOn: [{ id: "T-0001", type: "start-to-start", lag: 1 }],
        },
      ]),
    );
    assert.equal(g.relations.get("T-0002")!.earliestStart, "2026-03-11");
  });

  it("rolls the due date up from the deepest descendant", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic", due: "2026-03-01" },
        { id: "T-0002", level: "feature", parent: "T-0001", due: "2026-03-20" },
        { id: "T-0003", level: "task", parent: "T-0002", due: "2026-04-05" },
      ]),
    );
    assert.equal(g.relations.get("T-0001")!.rolledDue, "2026-04-05");
  });
});

describe("buildGraph — broken tasks", () => {
  it("keeps broken tasks out of the graph without dropping the healthy ones", () => {
    const g = buildGraph(
      makeWorkspace([
        { id: "T-0001", level: "epic" },
        { id: "T-0002", level: "feature", parent: "T-0001", broken: true },
        { id: "T-0003", level: "feature", parent: "T-0001" },
      ]),
    );
    assert.ok(!g.relations.has("T-0002"));
    assert.deepEqual(g.relations.get("T-0001")!.children, ["T-0003"]);
  });
});
