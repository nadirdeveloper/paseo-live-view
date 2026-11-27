import { describe, expect, test } from "vitest";
import type { LiveEvent } from "./events";
import { afterCall, alreadyShown } from "./feedPlan";

const base = { key: "k", agentId: "a", agentLabel: "claude", at: "" };
type Status = LiveEvent["status"];
const shell = (status: Status): LiveEvent => ({ ...base, status, kind: "shell", command: "x", hiddenLines: 0 });
const other = (status: Status): LiveEvent => ({ ...base, status, kind: "other", name: "NotebookEdit", input: {} });
const read = (status: Status): LiveEvent => ({ ...base, status, kind: "read", filePath: "/w/a", content: "", offset: null, limit: null });
const search = (status: Status): LiveEvent => ({ ...base, status, kind: "search", toolName: "grep", query: "x", filePaths: [] });
const edit = (status: Status): LiveEvent => ({ ...base, status, kind: "edit", filePath: "/w/a", inWorkspace: true });

describe("afterCall", () => {
  test("a finished command checks for changed files and reads", () => {
    expect(afterCall(shell("completed"))).toEqual({ checkChanges: true, reads: true });
    expect(afterCall(shell("failed"))).toEqual({ checkChanges: true, reads: true });
  });

  test("a running or canceled command does nothing yet", () => {
    expect(afterCall(shell("running"))).toEqual({ checkChanges: false, reads: false });
    expect(afterCall(shell("canceled"))).toEqual({ checkChanges: false, reads: false });
  });

  test("other tools check for changes and reads", () => {
    expect(afterCall(other("completed"))).toEqual({ checkChanges: true, reads: true });
  });

  test("reads and searches only read", () => {
    expect(afterCall(read("completed"))).toEqual({ checkChanges: false, reads: true });
    expect(afterCall(search("completed"))).toEqual({ checkChanges: false, reads: true });
    expect(afterCall(search("running"))).toEqual({ checkChanges: false, reads: false });
  });

  test("edits and writes are already replayed directly", () => {
    expect(afterCall(edit("completed"))).toEqual({ checkChanges: false, reads: false });
  });
});

describe("alreadyShown", () => {
  test("an edit whose result a change check already typed is not replayed again", () => {
    const shown = new Map([["/w/a", "new text"]]);
    const ev: LiveEvent = { ...base, status: "completed", kind: "edit", filePath: "/w/a", inWorkspace: true, afterText: "new text" };
    expect(alreadyShown(shown, ev)).toBe(true);
    // Used once: a later edit that happens to produce the same text still plays.
    expect(alreadyShown(shown, ev)).toBe(false);
  });

  test("an edit with a different result plays", () => {
    const shown = new Map([["/w/a", "older"]]);
    const ev: LiveEvent = { ...base, status: "completed", kind: "write", filePath: "/w/a", inWorkspace: true, content: "x", afterText: "x" };
    expect(alreadyShown(shown, ev)).toBe(false);
  });
});
