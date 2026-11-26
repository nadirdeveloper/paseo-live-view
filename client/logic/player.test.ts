import { describe, expect, test } from "vitest";
import type { EditEvent, LiveEvent, ShellEvent, SubagentEvent, WriteEvent } from "./events";
import { effectiveCps, eventChars } from "./pacing";
import {
  applyUpdate,
  createPlayer,
  enqueue,
  seedHistory,
  setPaused,
  setSpeed,
  skipToLive,
  tick,
  type PlayerState,
} from "./player";

let n = 0;
const base = () => ({ key: `a:${n++}`, agentId: "a", agentLabel: "claude", at: "t", status: "completed" as const });

function edit(afterText: string, oldString: string, newString: string, filePath = "/w/f.js"): EditEvent {
  return { ...base(), kind: "edit", filePath, inWorkspace: true, oldString, newString, afterText };
}
function write(content: string, filePath = "/w/new.js"): WriteEvent {
  return { ...base(), kind: "write", filePath, inWorkspace: true, content, afterText: content };
}
function shell(command: string, output?: string, status: ShellEvent["status"] = "completed"): ShellEvent {
  return { ...base(), kind: "shell", command, output, hiddenLines: 0, exitCode: status === "completed" ? 0 : undefined, status };
}

function run(state: PlayerState, totalMs: number, stepMs = 100): PlayerState {
  let s = state;
  for (let t = 0; t < totalMs; t += stepMs) s = tick(s, stepMs);
  return s;
}

function timeToDrain(state: PlayerState, stepMs = 100, limitMs = 120000): number {
  let s = state;
  let t = 0;
  while ((s.current || s.queue.length > 0) && t < limitMs) {
    s = tick(s, stepMs);
    t += stepMs;
  }
  return t;
}

describe("pacing", () => {
  test("base speed is 40 characters a second, scaled by the speed choice", () => {
    expect(effectiveCps(1, 0)).toBe(40);
    expect(effectiveCps(0.5, 0)).toBe(20);
    expect(effectiveCps(2, 0)).toBe(80);
  });

  test("speeds up so the remaining characters finish within 15 seconds", () => {
    expect(effectiveCps(1, 1500)).toBe(100);
  });

  test("speeds up further when less time is left", () => {
    expect(effectiveCps(1, 1500, 5)).toBe(300);
  });

  test("counts typed characters per event", () => {
    expect(eventChars(edit("x", "old", "new!"))).toBe(4);
    expect(eventChars(write("hello"))).toBe(5);
    expect(eventChars(shell("ls -la"))).toBe(6);
    const sub: SubagentEvent = { ...base(), kind: "subagent", description: "x", actions: [] };
    expect(eventChars(sub)).toBe(0);
    expect(eventChars({ ...edit("x", "a", "b"), status: "failed" })).toBe(0);
  });
});

describe("catch-up", () => {
  test("a burst of 10 edits drains within the 15 second target (plus slack)", () => {
    let s = createPlayer();
    for (let i = 0; i < 10; i++) {
      const text = "y".repeat(300);
      s = enqueue(s, edit(`head\n${text}\ntail`, "x", text));
    }
    expect(timeToDrain(s)).toBeLessThanOrEqual(17000);
  });

  test("a 200,000 character write finishes within 17 seconds", () => {
    const s = enqueue(createPlayer(), write("z".repeat(200000)));
    expect(timeToDrain(s)).toBeLessThanOrEqual(17000);
  });

  test("a mixed burst of 70 commands with long output and 20 edits drains within 17 seconds", () => {
    let s = createPlayer();
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    for (let i = 0; i < 70; i++) s = enqueue(s, shell(`command number ${i}`, output));
    for (let i = 0; i < 20; i++) {
      const text = "y".repeat(300);
      s = enqueue(s, edit(`head\n${text}\ntail`, "x", text));
    }
    expect(timeToDrain(s, 50)).toBeLessThanOrEqual(17000);
  });

  test("a single small edit plays in slow motion, not instantly", () => {
    const s = enqueue(createPlayer(), edit("a\nNEW TEXT HERE\nc", "OLD", "NEW TEXT HERE"));
    expect(timeToDrain(s)).toBeGreaterThan(300);
  });
});

describe("edit replay frames", () => {
  test("deletes the old text, types the new one with a cursor, then highlights it", () => {
    let s = enqueue(createPlayer(), edit("a\nNEW\nc", "OLD", "NEW"));
    const frames: { text: string; cursor: number | null }[] = [];
    while (s.current || s.queue.length) {
      s = tick(s, 10);
      if (s.editor) frames.push({ text: s.editor.text, cursor: s.editor.cursor });
    }
    expect(frames[0]).toEqual({ text: "a\nOLD\nc", cursor: 5 });
    expect(frames.some((f) => f.text === "a\n\nc" && f.cursor === 2)).toBe(true);
    expect(frames.some((f) => f.text === "a\nN\nc" && f.cursor === 3)).toBe(true);
    expect(s.editor).toMatchObject({ text: "a\nNEW\nc", cursor: null, highlight: { startLine: 2, endLine: 2 } });
    expect(s.editor?.filePath).toBe("/w/f.js");
  });

  test("an edit that can't be placed is shown on its own with a note", () => {
    const s = run(enqueue(createPlayer(), edit("nothing here", "OLD", "NEW")), 5000);
    expect(s.editor).toMatchObject({ text: "NEW", note: "file has changed since" });
  });

  test("an edit with no snapshot says the content is unavailable", () => {
    const s = run(enqueue(createPlayer(), edit(null as unknown as string, "OLD", "NEW")), 5000);
    expect(s.editor?.note).toBe("file content unavailable");
  });

  test("a write types the content into an empty editor", () => {
    let s = enqueue(createPlayer(), write("hello"));
    s = tick(s, 400);
    expect(s.editor?.text.length).toBeLessThan(5);
    s = run(s, 5000);
    expect(s.editor?.text).toBe("hello");
  });

  test("touched files include every edited or written path", () => {
    let s = enqueue(createPlayer(), edit("NEW", "OLD", "NEW", "/w/a.js"));
    s = enqueue(s, write("x", "/w/b.js"));
    expect(s.touched).toEqual(["/w/a.js", "/w/b.js"]);
  });
});

describe("terminal", () => {
  test("types the command, then reveals the output", () => {
    let s = enqueue(createPlayer(), shell("node --test", "ok 1\nok 2"));
    s = tick(s, 100);
    expect(s.terminal[0].typedCommand.length).toBeLessThan("node --test".length);
    s = run(s, 3000);
    expect(s.terminal[0]).toMatchObject({ typedCommand: "node --test", output: "ok 1\nok 2", shownOutputLines: 2, exitCode: 0 });
  });

  test("a running command moves on, and its output fills in when it finishes", () => {
    const running = shell("ls", undefined, "running");
    let s = run(enqueue(createPlayer(), running), 3000);
    expect(s.current).toBeNull();
    expect(s.terminal[0]).toMatchObject({ status: "running", typedCommand: "ls" });
    s = applyUpdate(s, { ...running, status: "completed", output: "a", exitCode: 0 });
    expect(s.terminal[0]).toMatchObject({ status: "completed", output: "a", shownOutputLines: 1, exitCode: 0 });
  });

  test("failed edits and sub-agents appear instantly", () => {
    const failed: LiveEvent = { ...edit("x", "a", "b", "/w/bad.js"), status: "failed" };
    const sub: SubagentEvent = { ...base(), kind: "subagent", description: "Explore", actions: ["Read a"] };
    let s = enqueue(enqueue(createPlayer(), failed), sub);
    s = tick(s, 10);
    expect(s.terminal.map((e) => e.kind)).toEqual(["failed-edit", "subagent"]);
    expect(s.terminal[0].command).toBe("/w/bad.js");
  });
});

describe("controls", () => {
  test("pause freezes everything", () => {
    const s = setPaused(enqueue(createPlayer(), shell("ls", "a")), true);
    expect(tick(s, 5000)).toEqual(s);
  });

  test("speed choice is stored", () => {
    expect(setSpeed(createPlayer(), 2).speed).toBe(2);
  });

  test("skip to live finishes everything instantly", () => {
    let s = createPlayer();
    s = enqueue(s, shell("one", "1"));
    s = enqueue(s, edit("A\nNEW", "OLD", "NEW", "/w/x.js"));
    s = enqueue(s, shell("two", "2"));
    s = skipToLive(s);
    expect(s.queue).toHaveLength(0);
    expect(s.current).toBeNull();
    expect(s.editor).toMatchObject({ filePath: "/w/x.js", text: "A\nNEW" });
    expect(s.terminal.map((e) => [e.typedCommand, e.output])).toEqual([
      ["one", "1"],
      ["two", "2"],
    ]);
  });
});

describe("history", () => {
  test("history fills the terminal and touched files without animating", () => {
    const s = seedHistory(createPlayer(), [shell("a", "1"), edit("x", "y", "x", "/w/h.js"), shell("b", "2")]);
    expect(s.terminal.map((e) => e.typedCommand)).toEqual(["a", "b"]);
    expect(s.terminal[0].shownOutputLines).toBe(1);
    expect(s.touched).toEqual(["/w/h.js"]);
    expect(s.editor).toBeNull();
    expect(s.queue).toHaveLength(0);
    expect(s.done).toHaveLength(3);
  });
});
