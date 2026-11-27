import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, test } from "vitest";
import { emptyLog, toLiveEvent, trimOutput, upsertEvent, type EventContext } from "./events";

const ctx: EventContext = {
  agentId: "agent-1",
  agentLabel: "claude",
  agentCwd: "/w",
  workspaceDir: "/w",
  at: "2026-11-26T10:00:00Z",
};

function toolCall(
  detail: ToolCallDetail,
  status: "running" | "completed" | "failed" | "canceled" = "completed",
  callId = "call-1",
): AgentTimelineItem {
  return { type: "tool_call", callId, name: detail.type, status, error: status === "failed" ? "boom" : null, detail } as AgentTimelineItem;
}

describe("toLiveEvent", () => {
  test("an edit with a relative path resolves against the agent cwd", () => {
    const ev = toLiveEvent(toolCall({ type: "edit", filePath: "script.js", oldString: "a", newString: "b" }), ctx);
    expect(ev).toMatchObject({
      kind: "edit",
      key: "agent-1:call-1",
      filePath: "/w/script.js",
      inWorkspace: true,
      oldString: "a",
      newString: "b",
      agentLabel: "claude",
      status: "completed",
    });
  });

  test("an agent cwd in a subfolder still counts as inside the workspace", () => {
    const ev = toLiveEvent(toolCall({ type: "edit", filePath: "x.ts" }), { ...ctx, agentCwd: "/w/src" });
    expect(ev).toMatchObject({ filePath: "/w/src/x.ts", inWorkspace: true });
  });

  test("a write outside the workspace is flagged", () => {
    const ev = toLiveEvent(toolCall({ type: "write", filePath: "/tmp/x.txt", content: "hi" }), ctx);
    expect(ev).toMatchObject({ kind: "write", filePath: "/tmp/x.txt", inWorkspace: false, content: "hi" });
  });

  test("a sibling folder that shares the prefix is not inside", () => {
    const ev = toLiveEvent(toolCall({ type: "write", filePath: "/w-other/x.txt" }), ctx);
    expect(ev).toMatchObject({ inWorkspace: false });
  });

  test("a shell call keeps command, output and exit code", () => {
    const ev = toLiveEvent(toolCall({ type: "shell", command: "ls", output: "a\nb", exitCode: 0 }), ctx);
    expect(ev).toMatchObject({ kind: "shell", command: "ls", output: "a\nb", hiddenLines: 0, exitCode: 0 });
  });

  test("a shell call with huge output keeps only the tail", () => {
    const output = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const ev = toLiveEvent(toolCall({ type: "shell", command: "pnpm install", output }), ctx);
    expect(ev).toMatchObject({ kind: "shell", hiddenLines: 800 });
    if (ev?.kind !== "shell") throw new Error("expected shell");
    expect(ev.output?.split("\n")).toHaveLength(200);
    expect(ev.output?.endsWith("line 999")).toBe(true);
  });

  test("a sub-agent call becomes one line with its actions", () => {
    const ev = toLiveEvent(
      toolCall({
        type: "sub_agent",
        description: "Explore",
        actions: [
          { index: 0, toolName: "Read", summary: "script.js" },
          { index: 1, toolName: "Bash" },
        ],
      }),
      ctx,
    );
    expect(ev).toMatchObject({ kind: "subagent", description: "Explore", actions: ["Read script.js", "Bash"] });
  });

  test("user messages and web fetches are ignored", () => {
    expect(toLiveEvent({ type: "user_message", text: "hi" } as AgentTimelineItem, ctx)).toBeNull();
    expect(toLiveEvent(toolCall({ type: "fetch", url: "https://x" }), ctx)).toBeNull();
  });

  test("a grep search keeps its matches, with file paths resolved", () => {
    const ev = toLiveEvent(
      toolCall({ type: "search", query: "pick", toolName: "grep", content: "script.js:33:pick", filePaths: ["script.js"], mode: "content" }),
      ctx,
    );
    expect(ev).toMatchObject({ kind: "search", toolName: "grep", query: "pick", content: "script.js:33:pick", filePaths: ["/w/script.js"], mode: "content" });
  });

  test("a search without a tool name or files still maps", () => {
    expect(toLiveEvent(toolCall({ type: "search", query: "x" }), ctx)).toMatchObject({ kind: "search", toolName: "search", filePaths: [] });
  });

  test("an unknown tool becomes an other-tool event with its name and input", () => {
    const item = { ...toolCall({ type: "unknown", input: { notebook_path: "/w/a.ipynb" }, output: null }), name: "NotebookEdit" } as AgentTimelineItem;
    expect(toLiveEvent(item, ctx)).toMatchObject({ kind: "other", name: "NotebookEdit", input: { notebook_path: "/w/a.ipynb" } });
  });

  test("a plain-text tool becomes an other-tool event with no input", () => {
    const item = { ...toolCall({ type: "plain_text", text: "done" }), name: "mcp__fs__write_file" } as AgentTimelineItem;
    expect(toLiveEvent(item, ctx)).toMatchObject({ kind: "other", name: "mcp__fs__write_file", input: {} });
  });
});

describe("review-related events", () => {
  test("reasoning becomes a thought", () => {
    const ev = toLiveEvent({ type: "reasoning", text: "Reading the diff" } as AgentTimelineItem, { ...ctx, seq: 7 });
    expect(ev).toMatchObject({ kind: "thought", source: "reasoning", text: "Reading the diff", key: "agent-1:thought:7" });
  });

  test("an assistant message becomes a thought keyed by its id", () => {
    const ev = toLiveEvent({ type: "assistant_message", text: "Done", messageId: "m1" } as AgentTimelineItem, ctx);
    expect(ev).toMatchObject({ kind: "thought", source: "message", text: "Done", key: "agent-1:msg:m1" });
  });

  test("a read tool call becomes a read event", () => {
    const ev = toLiveEvent(toolCall({ type: "read", filePath: "/tmp/pr.diff", content: "x\ny", offset: 400, limit: 200 }), ctx);
    expect(ev).toMatchObject({ kind: "read", filePath: "/tmp/pr.diff", content: "x\ny", offset: 400, limit: 200 });
  });

  test("review commands keep their untrimmed output", () => {
    const output = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n");
    const ev = toLiveEvent(toolCall({ type: "shell", command: "gh pr diff 12", output }), ctx);
    if (ev?.kind !== "shell") throw new Error("expected shell");
    expect(ev.rawOutput).toBe(output);
    expect(ev.hiddenLines).toBe(800);
  });

  test("other commands don't keep raw output", () => {
    const ev = toLiveEvent(toolCall({ type: "shell", command: "ls", output: "a" }), ctx);
    if (ev?.kind !== "shell") throw new Error("expected shell");
    expect(ev.rawOutput).toBeUndefined();
  });
});

describe("trimOutput", () => {
  test("keeps the last 200 lines and counts the hidden ones", () => {
    const text = Array.from({ length: 1000 }, (_, i) => String(i)).join("\n");
    const out = trimOutput(text);
    expect(out.hiddenLines).toBe(800);
    expect(out.text.split("\n")[0]).toBe("800");
  });

  test("caps a single very long line at 20,000 characters", () => {
    const out = trimOutput("x".repeat(50000));
    expect(out.text).toHaveLength(20000);
  });

  test("leaves short output alone", () => {
    expect(trimOutput("a\nb")).toEqual({ text: "a\nb", hiddenLines: 0 });
  });
});

describe("upsertEvent", () => {
  const running = toLiveEvent(toolCall({ type: "shell", command: "ls" }, "running"), ctx)!;
  const done = toLiveEvent(toolCall({ type: "shell", command: "ls", output: "a", exitCode: 0 }), ctx)!;

  test("a first sighting is new", () => {
    const { log, change } = upsertEvent(emptyLog, running);
    expect(change).toBe("new");
    expect(log.order).toEqual(["agent-1:call-1"]);
  });

  test("running then finished is completed", () => {
    const first = upsertEvent(emptyLog, running).log;
    const { log, change } = upsertEvent(first, done);
    expect(change).toBe("completed");
    expect(log.byKey.get("agent-1:call-1")).toMatchObject({ status: "completed", output: "a" });
  });

  test("an identical repeat is none", () => {
    const first = upsertEvent(upsertEvent(emptyLog, running).log, done).log;
    expect(upsertEvent(first, done).change).toBe("none");
  });

  test("a new event that is already finished counts as completed", () => {
    expect(upsertEvent(emptyLog, done).change).toBe("completed");
  });

  test("a different call id appends in order", () => {
    const other = toLiveEvent(toolCall({ type: "shell", command: "pwd" }, "running", "call-2"), ctx)!;
    const log = upsertEvent(upsertEvent(emptyLog, running).log, other).log;
    expect(log.order).toEqual(["agent-1:call-1", "agent-1:call-2"]);
  });

  test("the same finished edit from history and then live is stored once", () => {
    const edit = toLiveEvent(toolCall({ type: "edit", filePath: "a.js", oldString: "x", newString: "y" }), ctx)!;
    const first = upsertEvent(emptyLog, edit).log;
    const second = upsertEvent(first, edit);
    expect(second.change).toBe("none");
    expect(second.log.order).toHaveLength(1);
  });

  test("the same call with only a different timestamp is none", () => {
    const edit = toLiveEvent(toolCall({ type: "edit", filePath: "a.js", oldString: "x", newString: "y" }), ctx)!;
    const first = upsertEvent(emptyLog, edit).log;
    expect(upsertEvent(first, { ...edit, at: "2026-11-26T10:05:00Z" }).change).toBe("none");
  });

  test("a later change to a running call is updated", () => {
    const partial = toLiveEvent(toolCall({ type: "shell", command: "ls", output: "a" }, "running"), ctx)!;
    const first = upsertEvent(emptyLog, running).log;
    expect(upsertEvent(first, partial).change).toBe("updated");
  });
});
