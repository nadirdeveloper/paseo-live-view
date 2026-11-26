import { describe, expect, test } from "vitest";
import type { ShellEvent } from "./events";
import { applyUpdate, createPlayer, enqueue, tick } from "./player";
import { displayMode } from "./review/mode";
import { emptyReview, setMode } from "./review/state";
import { summarizeThought } from "./thoughts";

let n = 0;
const shell = (command: string, status: ShellEvent["status"], output?: string): ShellEvent => ({
  key: "a:cmd", agentId: "a", agentLabel: "claude", at: "t", status, kind: "shell", command, output, hiddenLines: 0, exitCode: status === "completed" ? 0 : undefined,
});

describe("a command whose text arrives late (feedback #1)", () => {
  test("the terminal row picks up the command text from a later update", () => {
    let s = enqueue(createPlayer(), shell("", "running"));
    for (let i = 0; i < 20; i++) s = tick(s, 50);
    s = applyUpdate(s, shell("gh pr checks 2687", "running"));
    expect(s.terminal[0]).toMatchObject({ command: "gh pr checks 2687", typedCommand: "gh pr checks 2687" });
    s = applyUpdate(s, shell("gh pr checks 2687", "completed", "7 pass"));
    expect(s.terminal[0]).toMatchObject({ status: "completed", output: "7 pass" });
  });
});

describe("the user's pick lasts until something new plays (feedback #2)", () => {
  test("pressing Review holds while nothing new plays, then an edit switches back to Code", () => {
    const picked = setMode({ ...emptyReview, mode: "code" }, "review", "a:edit1");
    // Third argument: the key of the latest playback that started.
    expect(displayMode(picked, null, "a:edit1", "code")).toBe("review");
    expect(displayMode(picked, "text", "a:edit1", "code")).toBe("review");
    expect(displayMode(picked, "text", "a:edit2", "code")).toBe("code");
    expect(displayMode(picked, null, "a:edit2", "code")).toBe("code");
    expect(displayMode(picked, "read", "read:x", "code")).toBe("review");
  });
});

describe("summarizeThought (feedback #4)", () => {
  test("drops code blocks, tables and markdown, and keeps the first sentence", () => {
    const text = "Done. **Live View** is built.\n\n```ui\nCard(\"x\")\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(summarizeThought(text)).toBe("Done.");
  });

  test("uses the first line of a report heading", () => {
    expect(summarizeThought("## ABC-123 — Security fix\n\n| Field | Value |")).toBe("ABC-123 — Security fix");
  });

  test("keeps short plain reasoning as it is", () => {
    expect(summarizeThought("Checking the Dockerfile for the build args")).toBe("Checking the Dockerfile for the build args");
  });

  test("cuts long text at a word boundary", () => {
    const out = summarizeThought("word ".repeat(80));
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith("…")).toBe(true);
  });
});
