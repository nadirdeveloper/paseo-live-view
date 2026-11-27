import { describe, expect, test } from "vitest";
import type { LiveEvent, ShellEvent, ThoughtEvent } from "../events";
import { forLog } from "../events";
import { addThought, emptyLane, interrupt } from "../thoughts";
import { detectReviewCommand } from "./commands";
import { parseUnifiedDiff } from "./diff";
import { placeFinding, type Finding } from "./findings";
import { applyToReview, emptyReview, type ReviewState } from "./state";
import { displayMode } from "./mode";

let n = 0;
const base = (agentId = "a") => ({ key: `${agentId}:${n++}`, agentId, agentLabel: "claude", at: "t", status: "completed" as const });
const msg = (text: string, key?: string, agentId = "a"): ThoughtEvent => ({ ...base(agentId), ...(key ? { key } : {}), kind: "thought", source: "message", text });
const reasoning = (text: string, agentId = "a"): ThoughtEvent => ({ ...base(agentId), kind: "thought", source: "reasoning", text });
const shell = (command: string, output: string): ShellEvent => ({ ...base(), kind: "shell", command, output, rawOutput: output, hiddenLines: 0, exitCode: 0 });
const apply = (events: LiveEvent[], start: ReviewState = emptyReview) => {
  let state = start;
  const effects = [];
  for (const ev of events) {
    const r = applyToReview(state, ev);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
};
const chunks = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const diff = (name: string, at: number) => [
  `diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, `@@ -${at},1 +${at},2 @@`, ` ctx ${name}`, `+new ${name}`,
];
const report = "| PR | [acme/pay#12](u) |\n\n### Code findings\n#### 🔴 Critical\n1. `a.ts:2` — wrong → fix\n\n### Verdict\nNot ready — x\n";

describe("streamed messages (review #1)", () => {
  test("a report streamed in chunks without ids still produces findings and a verdict", () => {
    const start = apply([shell("gh pr diff https://github.com/acme/pay/pull/12", diff("a.ts", 1).join("\n"))]).state;
    const { state } = apply(chunks(report, 20).map((c) => msg(c)), start);
    expect(state.reviews[0].report?.verdict).toBe("not-ready");
    expect(state.reviews[0].report?.findings).toHaveLength(1);
  });

  test("chunks that share one message id are appended, not replaced", () => {
    const start = apply([shell("gh pr diff https://github.com/acme/pay/pull/12", diff("a.ts", 1).join("\n"))]).state;
    const { state } = apply(chunks(report, 20).map((c) => msg(c, "a:msg:m1")), start);
    expect(state.reviews[0].report?.findings).toHaveLength(1);
  });

  test("the thinking strip joins message chunks into one readable message", () => {
    let lane = emptyLane;
    for (const c of chunks("Here is the full answer.", 5)) lane = addThought(lane, msg(c), { instant: false });
    expect(lane.items.map((t) => t.text)).toEqual(["Here is the full answer."]);
  });

  test("shared-id chunks join too, and a later whole copy replaces them", () => {
    let lane = emptyLane;
    for (const c of chunks("Hello there", 4)) lane = addThought(lane, msg(c, "a:msg:m2"), { instant: false });
    expect(lane.items.map((t) => t.text)).toEqual(["Hello there"]);
    lane = addThought(lane, msg("Hello there", "a:msg:m2"), { instant: true });
    expect(lane.items.map((t) => t.text)).toEqual(["Hello there"]);
  });

  test("another agent's activity doesn't split this agent's reasoning", () => {
    let lane = addThought(emptyLane, reasoning("I am ", "a"), { instant: false });
    lane = interrupt(lane, "b");
    lane = addThought(lane, reasoning("reading", "a"), { instant: false });
    expect(lane.items.map((t) => t.text)).toEqual(["I am reading"]);
  });
});

describe("gaps hide file headers (review #2)", () => {
  test("lines after a gap are not filed under the previous file", () => {
    const lines: (string | undefined)[] = [...diff("a.ts", 1), "diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -40,1 +40,2 @@", " b40", "+b41"];
    lines[6] = lines[7] = lines[8] = undefined; // b.ts header not read yet
    const files = parseUnifiedDiff(lines);
    expect(files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(files[0].hunks).toHaveLength(1);
    const finding: Finding = { n: 1, severity: "high", path: "a.ts", line: 41, lineEnd: null, text: "x", decisionNeeded: false };
    const placed = placeFinding(finding, files);
    expect(placed.kind === "pinned" && placed.diffAt).toBe(4);
  });
});

describe("output that was shown and saved (review #10)", () => {
  test("gh pr diff | tee keeps the diff it showed", () => {
    const { state } = apply([shell("gh pr diff 12 | tee d.txt", diff("a.ts", 1).join("\n"))]);
    expect(state.reviews[0].files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  test("redirect then head in one command line uses the head output", () => {
    expect(detectReviewCommand("gh pr diff 12 > /tmp/pr.diff && head -n 300 /tmp/pr.diff")).toEqual({
      kind: "pr-diff", pr: "12", redirect: "/tmp/pr.diff", shown: false, readAfter: { from: 1, to: 300 },
    });
    const { state } = apply([shell("gh pr diff 12 > /tmp/pr.diff && head -n 300 /tmp/pr.diff", diff("a.ts", 1).join("\n"))]);
    expect(state.reviews[0].files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("saved outputs for head files and file lists (review #11)", () => {
  const persisted = (path: string, preview: string) =>
    `<persisted-output>\nOutput too large (40KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
  const readEv = (filePath: string, content: string): LiveEvent => ({ ...base(), kind: "read", filePath, content, offset: null, limit: null });

  test("a big file at PR head shows its preview, then fills in from the saved file", () => {
    let { state } = apply([shell("gh pr diff 12", diff("a.ts", 1).join("\n"))]);
    state = apply([shell('gh api "repos/o/r/contents/src/big.ts?ref=x" --jq .content | base64 -d', persisted("/tmp/big.txt", "line 1\nline 2"))], state).state;
    expect(state.reviews[0].headFiles.get("src/big.ts")).toBe("line 1\nline 2");
    state = apply([readEv("/tmp/big.txt", "line 1\nline 2\nline 3")], state).state;
    expect(state.reviews[0].headFiles.get("src/big.ts")).toBe("line 1\nline 2\nline 3");
  });

  test("a saved gh pr view file list is read from the saved file", () => {
    let { state } = apply([shell("gh pr diff 12", diff("a.ts", 1).join("\n"))]);
    state = apply([shell("gh pr view 12 --json files", persisted("/tmp/view.txt", '{"files":[{"pa'))], state).state;
    state = apply([readEv("/tmp/view.txt", JSON.stringify({ files: [{ path: "a.ts", additions: 1, deletions: 0 }] }))], state).state;
    expect(state.reviews[0].allFiles).toEqual([{ path: "a.ts", adds: 1, dels: 0 }]);
  });
});

describe("log copies are small (review #9)", () => {
  test("forLog drops raw output and read content", () => {
    const s = forLog(shell("cat x", "y".repeat(1000)));
    expect(s.kind === "shell" && s.rawOutput).toBeFalsy();
    const r = forLog({ ...base(), kind: "read", filePath: "/x", content: "big", offset: null, limit: null });
    expect(r.kind === "read" && r.content).toBe("");
  });
});

describe("which mode to show (review #8)", () => {
  test("follows what is playing, unless the user picked", () => {
    const state = { ...emptyReview, mode: "review" as const };
    expect(displayMode(state, "text", "k1", "review")).toBe("code");
    expect(displayMode(state, "read", "k2", "code")).toBe("review");
    // Reads and glances in the code editor switch back to Code, like edits.
    expect(displayMode(state, "view", "k3", "review")).toBe("code");
    expect(displayMode(state, "glance", "k4", "review")).toBe("code");
    expect(displayMode(state, null, "k2", "code")).toBe("code");
    expect(displayMode({ ...state, manual: true, manualKey: "k1", mode: "review" }, "text", "k1", "code")).toBe("review");
    expect(displayMode(state, null, null, null)).toBe("review");
  });
});
