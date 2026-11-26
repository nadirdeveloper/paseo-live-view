import { describe, expect, test } from "vitest";
import type { EditEvent, ShellEvent } from "./events";
import { createPlayer, currentPhase, enqueue, tick, type PlayerState } from "./player";
import { activeArea, pointerTarget } from "./pointer";

const edit: EditEvent = {
  key: "a:1", agentId: "a", agentLabel: "claude", at: "t", status: "completed", kind: "edit",
  filePath: "/w/f.js", inWorkspace: true, oldString: "OLD", newString: "A MUCH LONGER NEW TEXT", afterText: "x\nA MUCH LONGER NEW TEXT here\ny",
};

function until(s: PlayerState, done: (s: PlayerState) => boolean): PlayerState {
  for (let i = 0; i < 1000 && !done(s); i++) s = tick(s, 10);
  return s;
}

describe("the pointer stays where it clicked while the text is typed", () => {
  test("same target from the line click through deleting and typing", () => {
    let s = until(enqueue(createPlayer(), edit), (x) => currentPhase(x)?.phase === "delete");
    const clicked = pointerTarget(s);
    expect(clicked).toMatchObject({ kind: "editor", line: 2, column: 3 });
    s = until(s, (x) => currentPhase(x)?.phase === "type");
    s = tick(tick(s, 100), 100);
    expect(s.editor?.cursor).not.toBe(clicked && "column" in clicked ? clicked.column : -1);
    const { click: _c, ...still } = pointerTarget(s) as { click?: boolean };
    const { click: _d, ...first } = clicked as { click?: boolean };
    expect(still).toEqual(first);
  });
});

describe("activeArea", () => {
  test("names the pane being worked in", () => {
    expect(activeArea(null)).toBeNull();
    expect(activeArea({ kind: "tree", path: "/w/a", click: false })).toBe("files");
    expect(activeArea({ kind: "pr-file", reviewId: "r", path: "a", click: false })).toBe("files");
    expect(activeArea({ kind: "editor", path: "/w/a", line: 1, column: 0 })).toBe("editor");
    expect(activeArea({ kind: "diff", line: 3 })).toBe("editor");
    expect(activeArea({ kind: "terminal", key: "k" })).toBe("terminal");
  });

  test("a command makes the terminal active", () => {
    const sh: ShellEvent = { key: "a:2", agentId: "a", agentLabel: "c", at: "t", status: "completed", kind: "shell", command: "ls", output: "x", hiddenLines: 0, exitCode: 0 };
    expect(activeArea(pointerTarget(tick(enqueue(createPlayer(), sh), 10)))).toBe("terminal");
  });
});
