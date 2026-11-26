import { describe, expect, test } from "vitest";
import type { EditEvent } from "./events";
import { createPlayer, currentPhase, enqueue, tick, type PlayerState } from "./player";
import { pointerTarget } from "./pointer";

let n = 0;
const edit = (afterText: string, oldString: string, newString: string, filePath = "/w/f.js"): EditEvent => ({
  key: `a:${n++}`, agentId: "a", agentLabel: "claude", at: "t", status: "completed", kind: "edit", filePath, inWorkspace: true, oldString, newString, afterText,
});

function until(s: PlayerState, done: (s: PlayerState) => boolean, step = 10, limit = 5000): { s: PlayerState; t: number } {
  let t = 0;
  while (!done(s) && t < limit) {
    s = tick(s, step);
    t += step;
  }
  return { s, t };
}

describe("open the file, click the line, then edit", () => {
  const before = "line one\nline two\nOLD here\nline four";
  const after = "line one\nline two\nNEW here\nline four";

  test("after clicking the file, the pointer aims at the edit line before any text changes", () => {
    let { s } = until(enqueue(createPlayer(), edit(after, "OLD", "NEW")), (x) => currentPhase(x)?.phase === "aim");
    expect(s.editor?.text).toBe(before);
    expect(s.editor?.cursor).toBeNull();
    expect(s.editor?.focusLine).toBe(3);
    expect(pointerTarget(s)).toEqual({ kind: "editor", path: "/w/f.js", line: 3, column: 3, click: false });
    // The text only starts changing once the aim has finished (≥ 400 ms of aiming).
    const aimed = until(s, (x) => x.editor?.text !== before);
    expect(aimed.t).toBeGreaterThanOrEqual(400);
  });

  test("the pointer clicks the line near the end of the aim", () => {
    const { s } = until(enqueue(createPlayer(), edit(after, "OLD", "NEW")), (x) => {
      const t = pointerTarget(x);
      return t?.kind === "editor" && t.click === true;
    });
    expect(currentPhase(s)?.phase).toBe("aim");
  });

  test("when the file is already open, the pointer goes straight to the line", () => {
    let s = enqueue(createPlayer(), edit(after, "OLD", "NEW"));
    s = until(s, (x) => !x.current && x.queue.length === 0).s;
    s = enqueue(s, edit("line one\nline 2\nNEW here\nline four", "line two", "line 2"));
    s = tick(s, 10);
    expect(pointerTarget(s)).toMatchObject({ kind: "editor", path: "/w/f.js", line: 2 });
  });
});
