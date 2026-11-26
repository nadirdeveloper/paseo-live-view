import { describe, expect, test } from "vitest";
import type { EditEvent, ShellEvent } from "./events";
import { createPlayer, enqueue, enqueueRead, tick, type PlayerState } from "./player";
import { pointerTarget } from "./pointer";

let n = 0;
const base = () => ({ key: `a:${n++}`, agentId: "a", agentLabel: "claude", at: "t", status: "completed" as const });
const edit = (i: number): EditEvent => {
  const text = "y".repeat(300);
  return { ...base(), kind: "edit", filePath: `/w/f${i}.js`, inWorkspace: true, oldString: "x", newString: text, afterText: `h\n${text}\nt` };
};
const plan = { steps: [
  { path: "a.ts", from: 1, to: 100 },
  { path: "b.ts", from: 101, to: 200 },
  { path: "c.ts", from: 201, to: 300 },
] };

function drainTime(s: PlayerState, step = 50): { s: PlayerState; t: number } {
  let t = 0;
  while ((s.current || s.queue.length) && t < 120000) {
    s = tick(s, step);
    t += step;
  }
  return { s, t };
}

describe("reading playback", () => {
  test("a three-file read plus ten edits stays within the catch-up target", () => {
    let s = enqueueRead(createPlayer(), { kind: "read-diff", reviewId: "r", from: 1, to: 300 }, plan);
    for (let i = 0; i < 10; i++) s = enqueue(s, edit(i));
    expect(drainTime(s).t).toBeLessThanOrEqual(17000);
  });

  test("the reading position only moves forward, file by file", () => {
    let s = enqueueRead(createPlayer(), { kind: "read-diff", reviewId: "r", from: 1, to: 300 }, plan);
    const seen: [string, number][] = [];
    for (let i = 0; i < 400 && (s.current || s.queue.length); i++) {
      s = tick(s, 50);
      if (s.reader?.cursorAt != null) seen.push([s.reader.path, s.reader.cursorAt]);
    }
    const positions = seen.map(([, at]) => at);
    expect(positions.every((at, i) => i === 0 || at >= positions[i - 1])).toBe(true);
    expect([...new Set(seen.map(([path]) => path))]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(s.reader).toMatchObject({ reviewId: "r", mode: "diff", path: "c.ts", from: 201, to: 300 });
  });

  test("a single read plays slowly enough to watch", () => {
    const s = enqueueRead(createPlayer(), { kind: "read-diff", reviewId: "r", from: 1, to: 50 }, { steps: [{ path: "a.ts", from: 1, to: 50 }] });
    expect(drainTime(s).t).toBeGreaterThan(1500);
  });

  test("a whole file at PR head sweeps from top to bottom", () => {
    let s = enqueueRead(createPlayer(), { kind: "read-file", reviewId: "r", path: "src/a.ts" }, { steps: [{ path: "src/a.ts", from: 1, to: 100 }] });
    s = tick(s, 2000);
    expect(s.reader).toMatchObject({ mode: "file", path: "src/a.ts" });
    const early = s.reader!.cursorAt!;
    s = tick(s, 500);
    expect(s.reader!.cursorAt!).toBeGreaterThan(early);
  });
});

describe("pointer while reading", () => {
  test("goes to the PR file, clicks, then follows the reading line", () => {
    let s = enqueueRead(createPlayer(), { kind: "read-diff", reviewId: "r", from: 1, to: 100 }, { steps: [{ path: "a.ts", from: 1, to: 100 }] });
    s = tick(s, 10);
    expect(pointerTarget(s)).toEqual({ kind: "pr-file", reviewId: "r", path: "a.ts", click: false });
    s = tick(s, 600);
    expect(pointerTarget(s)).toEqual({ kind: "pr-file", reviewId: "r", path: "a.ts", click: true });
    s = tick(s, 800);
    const target = pointerTarget(s);
    expect(target?.kind).toBe("diff");
    if (target?.kind === "diff") expect(target.line).toBeGreaterThan(1);
  });
});

describe("memory", () => {
  test("finished commands drop their raw output", () => {
    const ev: ShellEvent = { ...base(), kind: "shell", command: "gh pr diff 1", output: "x", rawOutput: "x".repeat(1000), hiddenLines: 0, exitCode: 0 };
    const { s } = drainTime(enqueue(createPlayer(), ev));
    const done = s.done[0];
    expect(done.kind === "shell" && done.rawOutput).toBeFalsy();
  });
});
