import { describe, expect, test } from "vitest";
import { laneRole, nameLanes, orderLanes, pickLane, type LaneInfo } from "./lanes";

const lane = (id: string, over: Partial<LaneInfo> = {}): LaneInfo => ({
  id, parentId: null, label: id, kind: "agent", status: "running", fallback: false, task: null, lastStartedAt: 0, createdAt: 0, ...over,
});

describe("nameLanes", () => {
  test("numbers duplicate labels by creation order", () => {
    const named = nameLanes([
      lane("a"),
      lane("a:1", { label: "Explore", kind: "subagent", parentId: "a", createdAt: 1 }),
      lane("a:2", { label: "Explore", kind: "subagent", parentId: "a", createdAt: 2 }),
      lane("a:3", { label: "Reviewer", kind: "subagent", parentId: "a", createdAt: 3 }),
    ]);
    expect(named.map((l) => l.label)).toEqual(["a", "Explore #1", "Explore #2", "Reviewer"]);
  });
});

describe("pickLane", () => {
  const lanes = [lane("a", { lastStartedAt: 5 }), lane("a:1", { lastStartedAt: 9, createdAt: 1 }), lane("a:2", { lastStartedAt: 9, createdAt: 2 })];

  test("auto picks the latest start, newest lane on a tie", () => {
    expect(pickLane(lanes, "auto")).toBe("a:2");
  });

  test("a pinned lane stays", () => {
    expect(pickLane(lanes, "a")).toBe("a");
  });

  test("a pinned lane that's gone falls back to auto", () => {
    expect(pickLane(lanes, "zzz")).toBe("a:2");
  });

  test("no lanes, no pick", () => {
    expect(pickLane([], "auto")).toBeNull();
  });
});

describe("orderLanes", () => {
  test("parents before their children, nested by creation", () => {
    const ordered = orderLanes([
      lane("b", { createdAt: 5 }),
      lane("a:1:x", { parentId: "a:1", createdAt: 3 }),
      lane("a:1", { parentId: "a", createdAt: 2 }),
      lane("a", { createdAt: 1 }),
      lane("a:2", { parentId: "a", createdAt: 4 }),
    ]);
    expect(ordered.map((l) => l.id)).toEqual(["a", "a:1", "a:1:x", "a:2", "b"]);
  });
});

describe("laneRole", () => {
  const lanes = [
    lane("a", { label: "Fix the bug" }),
    lane("a:1", { parentId: "a", kind: "subagent", label: "Explore #1", createdAt: 1 }),
    lane("a:1:x", { parentId: "a:1", kind: "subagent", label: "Reviewer", createdAt: 2 }),
  ];

  test("names main agents, subagents and their subagents clearly", () => {
    expect(laneRole(lanes, "a")).toEqual({ role: "Main agent", startedBy: null });
    expect(laneRole(lanes, "a:1")).toEqual({ role: "Subagent", startedBy: "Main agent" });
    expect(laneRole(lanes, "a:1:x")).toEqual({ role: "Sub-subagent", startedBy: "Explore #1" });
  });
});
