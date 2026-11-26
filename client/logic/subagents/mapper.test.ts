import { describe, expect, test } from "vitest";
import type { Entry } from "../../../shared/subagents";
import { entryToEvents } from "./mapper";

const ctx = { laneId: "a:toolu_x", agentLabel: "Explore #1", agentCwd: "/w", workspaceDir: "/w" };
const tool = (name: string, input: Record<string, unknown>, result?: string, isError?: boolean): Entry => ({
  kind: "tool", callId: "c1", name, input, ...(result !== undefined ? { result, isError: isError ?? false } : {}),
});

describe("entryToEvents", () => {
  test("Edit becomes an edit, with a relative path resolved", () => {
    expect(entryToEvents(tool("Edit", { file_path: "script.js", old_string: "a", new_string: "b" }, "ok"), ctx)).toMatchObject([
      { kind: "edit", key: "a:toolu_x:c1", filePath: "/w/script.js", inWorkspace: true, oldString: "a", newString: "b", status: "completed", agentLabel: "Explore #1" },
    ]);
  });

  test("an Edit without its result yet is still running", () => {
    expect(entryToEvents(tool("Edit", { file_path: "/w/a.js", old_string: "a", new_string: "b" }), ctx)[0]).toMatchObject({ status: "running" });
  });

  test("MultiEdit becomes one edit per change", () => {
    const events = entryToEvents(tool("MultiEdit", { file_path: "/w/a.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }, "ok"), ctx);
    expect(events.map((e) => e.key)).toEqual(["a:toolu_x:c1:0", "a:toolu_x:c1:1"]);
  });

  test("Write becomes a write", () => {
    expect(entryToEvents(tool("Write", { file_path: "/w/n.md", content: "# N" }, "ok"), ctx)).toMatchObject([{ kind: "write", content: "# N" }]);
  });

  test("Bash becomes a command with output and exit code", () => {
    expect(entryToEvents(tool("Bash", { command: "ls" }, "a\nb"), ctx)).toMatchObject([{ kind: "shell", command: "ls", output: "a\nb", exitCode: 0, status: "completed" }]);
    expect(entryToEvents(tool("Bash", { command: "false" }, "Exit code 1", true), ctx)).toMatchObject([{ kind: "shell", exitCode: 1, status: "failed" }]);
    expect(entryToEvents(tool("Bash", { command: "sleep 9" }), ctx)).toMatchObject([{ kind: "shell", status: "running" }]);
  });

  test("Read becomes a read with its content", () => {
    expect(entryToEvents(tool("Read", { file_path: "/tmp/pr.diff", offset: 400, limit: 200 }, "x"), ctx)).toMatchObject([
      { kind: "read", filePath: "/tmp/pr.diff", offset: 400, limit: 200, content: "x" },
    ]);
  });

  test("Agent and Task become nested subagents", () => {
    expect(entryToEvents(tool("Agent", { description: "Check styles", subagent_type: "Explore" }), ctx)).toMatchObject([
      { kind: "subagent", description: "Check styles", subAgentType: "Explore", callId: "c1" },
    ]);
    expect(entryToEvents(tool("Task", { description: "x" }), ctx)[0]).toMatchObject({ kind: "subagent" });
  });

  test("thinking and text become thoughts", () => {
    expect(entryToEvents({ kind: "thinking", id: "m1:0", text: "hmm" }, ctx)).toMatchObject([{ kind: "thought", source: "reasoning", text: "hmm", key: "a:toolu_x:m1:0" }]);
    expect(entryToEvents({ kind: "text", id: "m1:1", text: "done" }, ctx)).toMatchObject([{ kind: "thought", source: "message" }]);
  });

  test("other tools are ignored", () => {
    expect(entryToEvents(tool("WebFetch", { url: "x" }, "y"), ctx)).toEqual([]);
  });
});
