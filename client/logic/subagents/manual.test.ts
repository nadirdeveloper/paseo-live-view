import { describe, expect, test } from "vitest";
import { laneNotices, pickLane, type LaneInfo } from "./lanes";

const lane = (id: string, over: Partial<LaneInfo> = {}): LaneInfo => ({
  id, parentId: null, label: id, kind: "agent", status: "running", fallback: false, task: null, lastStartedAt: 0, createdAt: 0, ...over,
});

describe("watching the main agent by default", () => {
  test('"main" picks a main agent, never a subagent, even when the subagent is busier', () => {
    const lanes = [lane("a", { createdAt: 1 }), lane("a:s", { parentId: "a", kind: "subagent", lastStartedAt: 99, createdAt: 2 })];
    expect(pickLane(lanes, "main")).toBe("a");
  });

  test('"main" prefers the working, most recently active main agent', () => {
    const lanes = [lane("old", { status: "done", createdAt: 1 }), lane("now", { createdAt: 2, lastStartedAt: 5 })];
    expect(pickLane(lanes, "main")).toBe("now");
  });
});

describe("laneNotices", () => {
  const openedAt = 100;
  const main = lane("a", { createdAt: 1 });

  test("a subagent that appears after the panel opened is announced", () => {
    const sub = lane("a:s", { parentId: "a", kind: "subagent", label: "Explore #1", task: "find env", createdAt: 150 });
    expect(laneNotices([main], [main, sub], "a", openedAt)).toEqual([{ laneId: "a:s", kind: "started", label: "Explore #1", task: "find env" }]);
  });

  test("subagents loaded from history are not announced", () => {
    const sub = lane("a:s", { parentId: "a", kind: "subagent", createdAt: 50 });
    expect(laneNotices([main], [main, sub], "a", openedAt)).toEqual([]);
  });

  test("a subagent finishing or failing is announced", () => {
    const running = lane("a:s", { parentId: "a", kind: "subagent", label: "X", createdAt: 150 });
    expect(laneNotices([main, running], [main, { ...running, status: "done" }], "a", openedAt)).toMatchObject([{ kind: "finished" }]);
    expect(laneNotices([main, running], [main, { ...running, status: "failed" }], "a", openedAt)).toMatchObject([{ kind: "failed" }]);
  });

  test("nothing is announced about the lane you're already watching", () => {
    const running = lane("a:s", { parentId: "a", kind: "subagent", createdAt: 150 });
    expect(laneNotices([main, running], [main, { ...running, status: "done" }], "a:s", openedAt)).toEqual([]);
  });
});
