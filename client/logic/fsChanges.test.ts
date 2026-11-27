import { describe, expect, test } from "vitest";
import type { EditEvent } from "./events";
import { changeToEvents } from "./fsChanges";
import { reconstructEdit } from "./reconstruct";

const base = { key: "a:call-1", agentId: "a", agentLabel: "claude", at: "t" };
const path = "/w/script.js";

/** Rebuild the text before an edit the way the player does, to prove it replays. */
function replay(ev: EditEvent) {
  return reconstructEdit({ afterText: ev.afterText, oldString: ev.oldString, newString: ev.newString, unifiedDiff: ev.unifiedDiff, hintLine: ev.line });
}

describe("changeToEvents", () => {
  test("one changed line → one edit that replays from the old text", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\n";
    const events = changeToEvents({ path, before, after }, base) as EditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "edit", key: "a:call-1:fs:/w/script.js:0", filePath: path, inWorkspace: true, status: "completed", afterText: after });
    const rec = replay(events[0]);
    expect(rec.mode).toBe("replay");
    if (rec.mode === "replay") expect(rec.before).toBe(before);
  });

  test("two separate hunks → two edits applied in order", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n";
    const after = "1\nTWO\n3\n4\n5\n6\nSEVEN\n8\n";
    const events = changeToEvents({ path, before, after }, base) as EditEvent[];
    expect(events.map((e) => e.key)).toEqual(["a:call-1:fs:/w/script.js:0", "a:call-1:fs:/w/script.js:1"]);
    const first = replay(events[0]);
    const second = replay(events[1]);
    expect(first.mode === "replay" && first.before).toBe(before);
    expect(second.mode === "replay" && second.before).toBe(events[0].afterText);
    expect(events[1].afterText).toBe(after);
  });

  test("a repeated line is placed by its line number", () => {
    const before = "}\n}\n}\n";
    const after = "}\n}\n})\n";
    const [ev] = changeToEvents({ path, before, after }, base) as EditEvent[];
    const rec = replay(ev);
    expect(rec.mode === "replay" && rec.before).toBe(before);
  });

  test("an inserted line keeps the file's line breaks", () => {
    const before = "x\ny\n";
    const after = "x\nnew\ny\n";
    const [ev] = changeToEvents({ path, before, after }, base) as EditEvent[];
    const rec = replay(ev);
    expect(rec.mode === "replay" && rec.before).toBe(before);
  });

  test("a pure deletion can still be placed", () => {
    const before = "x\ngone\ny\n";
    const after = "x\ny\n";
    const [ev] = changeToEvents({ path, before, after }, base) as EditEvent[];
    const rec = replay(ev);
    expect(rec.mode).toBe("replay");
    expect(rec.mode === "replay" && rec.before).toBe(before);
  });

  test("a file without a final newline", () => {
    const before = "x\ny";
    const after = "x\nz";
    const [ev] = changeToEvents({ path, before, after }, base) as EditEvent[];
    const rec = replay(ev);
    expect(rec.mode === "replay" && rec.before).toBe(before);
  });

  test("a new file becomes a write", () => {
    expect(changeToEvents({ path, before: null, after: "hi\n" }, base)).toEqual([
      { ...base, key: "a:call-1:fs:/w/script.js", status: "completed", kind: "write", filePath: path, inWorkspace: true, content: "hi\n", afterText: "hi\n" },
    ]);
  });

  test("a deleted file shows nothing", () => {
    expect(changeToEvents({ path, before: "x\n", after: null }, base)).toEqual([]);
  });

  test("a huge change is highlighted instead of typed", () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n") + "\n";
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n") + "\n";
    const events = changeToEvents({ path, before, after }, base) as EditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].oldString).toBeUndefined();
    const rec = replay(events[0]);
    expect(rec.mode).toBe("diff-only");
    if (rec.mode === "diff-only") expect(rec.changedLines).toHaveLength(500);
  });

  test("many small hunks are highlighted instead of typed", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const before = lines.join("\n") + "\n";
    const after = lines.map((l, i) => (i % 4 === 0 ? l.toUpperCase() : l)).join("\n") + "\n";
    const events = changeToEvents({ path, before, after }, base) as EditEvent[];
    expect(events).toHaveLength(1);
    expect(replay(events[0]).mode).toBe("diff-only");
  });

  test("no difference → nothing", () => {
    expect(changeToEvents({ path, before: "same\n", after: "same\n" }, base)).toEqual([]);
  });
});
