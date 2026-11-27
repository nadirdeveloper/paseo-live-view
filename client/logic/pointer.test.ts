import { describe, expect, test } from "vitest";
import type { EditEvent, LiveEvent, ShellEvent } from "./events";
import { createPlayer, enqueue, tick, type PlayerState } from "./player";
import { pointerTarget } from "./pointer";

let n = 0;
const base = () => ({ key: `a:${n++}`, agentId: "a", agentLabel: "claude", at: "t", status: "completed" as const });
const edit = (afterText: string, oldString: string, newString: string): EditEvent => ({
  ...base(), kind: "edit", filePath: "/w/f.js", inWorkspace: true, oldString, newString, afterText,
});
const shell = (command: string): ShellEvent => ({ ...base(), kind: "shell", command, output: "ok", hiddenLines: 0, exitCode: 0 });

function until(s: PlayerState, done: (s: PlayerState) => boolean, step = 10): PlayerState {
  for (let i = 0; i < 2000 && !done(s); i++) s = tick(s, step);
  return s;
}

describe("pointerTarget", () => {
  test("an idle player has no target", () => {
    expect(pointerTarget(createPlayer())).toBeNull();
  });

  test("at the start of an edit it heads to the file in the tree", () => {
    const s = tick(enqueue(createPlayer(), edit("a\nNEW\nc", "OLD", "NEW")), 10);
    expect(pointerTarget(s)).toEqual({ kind: "tree", path: "/w/f.js", click: false });
  });

  test("near the end of the pause it clicks the file", () => {
    const s = until(tick(enqueue(createPlayer(), edit("a\nNEW\nc", "OLD", "NEW")), 10), (x) => {
      const t = pointerTarget(x);
      return t?.kind !== "tree" || t.click;
    });
    expect(pointerTarget(s)).toEqual({ kind: "tree", path: "/w/f.js", click: true });
  });

  test("while typing it stays where it clicked (end of the old text), not on the moving text cursor", () => {
    const s = until(enqueue(createPlayer(), edit("a\nNEW\nc", "OLD", "NEW")), (x) => x.editor?.text === "a\nN\nc");
    expect(pointerTarget(s)).toEqual({ kind: "editor", path: "/w/f.js", line: 2, column: 3 });
  });

  test("a diff-only edit points at the first highlighted line", () => {
    const ev: EditEvent = {
      ...base(), kind: "edit", filePath: "/w/f.js", inWorkspace: true,
      unifiedDiff: "@@ -1,2 +1,3 @@\n one\n+two\n three", afterText: "one\ntwo\nthree",
    };
    const s = tick(enqueue(createPlayer(), ev), 10);
    expect(pointerTarget(s)).toEqual({ kind: "editor", path: "/w/f.js", line: 2, column: 0 });
  });

  test("while a command types it points at that command in the terminal", () => {
    const ev = shell("node --test");
    const s = tick(enqueue(createPlayer(), ev), 10);
    expect(pointerTarget(s)).toEqual({ kind: "terminal", key: ev.key });
  });

  test("a view clicks the file, then aims at and clicks the first line read", () => {
    const view: LiveEvent = { ...base(), kind: "view", filePath: "/w/r.js", text: "a\nb\nc\nd\n", ranges: [{ from: 3, to: 4 }] };
    let s = tick(enqueue(createPlayer(), view), 10);
    expect(pointerTarget(s)).toEqual({ kind: "tree", path: "/w/r.js", click: false });
    s = until(s, (x) => x.current?.phase === "aim" && pointerTarget(x)?.kind === "editor" && (pointerTarget(x) as { click?: boolean }).click === true);
    expect(pointerTarget(s)).toEqual({ kind: "editor", path: "/w/r.js", line: 3, column: 0, click: true });
    s = until(s, (x) => x.current?.phase === "read");
    expect(pointerTarget(s)).toMatchObject({ kind: "editor", path: "/w/r.js", line: 3 });
  });

  test("a glance points at the first file in the tree", () => {
    const glance: LiveEvent = { ...base(), kind: "glance", paths: ["/w/a.css", "/w/b.css"] };
    expect(pointerTarget(tick(enqueue(createPlayer(), glance), 10))).toEqual({ kind: "tree", path: "/w/a.css", click: false });
  });
});
