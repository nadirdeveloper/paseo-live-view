import { describe, expect, test } from "vitest";
import type { ShellEvent } from "../events";
import { pushHistory } from "../events";
import { pickLane, type LaneInfo } from "./lanes";
import { entryToEvents } from "./mapper";

const lane = (id: string, over: Partial<LaneInfo> = {}): LaneInfo => ({
  id, parentId: null, label: id, kind: "agent", status: "running", fallback: false, task: null, lastStartedAt: 0, createdAt: 0, ...over,
});

describe("history batches with a call and its result (review #1)", () => {
  test("the later, finished copy replaces the running one", () => {
    const running: ShellEvent = { key: "s:c1", agentId: "s", agentLabel: "x", at: "t", status: "running", kind: "shell", command: "ls", hiddenLines: 0 };
    const done: ShellEvent = { ...running, status: "completed", output: "a\nb", exitCode: 0 };
    const list = pushHistory(pushHistory([], running), done);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "completed", output: "a\nb" });
  });
});

describe("Auto picks sensibly (review #2)", () => {
  test("with nothing played yet, the main agent wins over finished subagents", () => {
    const lanes = [lane("a", { createdAt: 1 }), lane("a:s", { parentId: "a", kind: "subagent", status: "done", createdAt: 2 })];
    expect(pickLane(lanes, "auto")).toBe("a");
  });

  test("on a tie, a working lane wins over a finished one", () => {
    const lanes = [
      lane("a", { lastStartedAt: 5, status: "done", createdAt: 1 }),
      lane("a:s", { parentId: "a", kind: "subagent", lastStartedAt: 5, status: "running", createdAt: 2 }),
    ];
    expect(pickLane(lanes, "auto")).toBe("a:s");
  });
});

describe("Read results drop their line numbers (review #15)", () => {
  test("cat -n style prefixes are removed", () => {
    const ctx = { laneId: "s", agentLabel: "x", agentCwd: "/w", workspaceDir: "/w" };
    const [ev] = entryToEvents({ kind: "tool", callId: "r", name: "Read", input: { file_path: "/tmp/pr.diff" }, result: "     1\tdiff --git a/x b/x\n     2\t--- a/x", isError: false }, ctx);
    expect(ev).toMatchObject({ kind: "read", content: "diff --git a/x b/x\n--- a/x" });
  });

  test("content without prefixes is left alone", () => {
    const ctx = { laneId: "s", agentLabel: "x", agentCwd: "/w", workspaceDir: "/w" };
    const [ev] = entryToEvents({ kind: "tool", callId: "r", name: "Read", input: { file_path: "/a" }, result: "plain\ntext", isError: false }, ctx);
    expect(ev).toMatchObject({ content: "plain\ntext" });
  });
});
