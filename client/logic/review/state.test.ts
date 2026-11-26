import { describe, expect, test } from "vitest";
import type { EditEvent, LiveEvent, ReadEvent, ShellEvent, ThoughtEvent } from "../events";
import { applyToReview, emptyReview, setMode, type ReviewState } from "./state";

let n = 0;
const base = () => ({ key: `a:${n++}`, agentId: "a", agentLabel: "claude", at: "t", status: "completed" as const });
const shell = (command: string, output: string): ShellEvent => ({
  ...base(), kind: "shell", command, output, rawOutput: output, hiddenLines: 0, exitCode: 0,
});
const read = (filePath: string, content: string, offset: number | null, limit: number | null): ReadEvent => ({
  ...base(), kind: "read", filePath, content, offset, limit,
});
const message = (text: string): ThoughtEvent => ({ ...base(), kind: "thought", source: "message", text });
const edit = (): EditEvent => ({ ...base(), kind: "edit", filePath: "/w/a.js", inWorkspace: true, oldString: "a", newString: "b" });

const fileBlock = (name: string, from: number) => [
  `diff --git a/${name} b/${name}`,
  `--- a/${name}`,
  `+++ b/${name}`,
  `@@ -${from},1 +${from},1 @@`,
  `-old ${name}`,
  `+new ${name}`,
];
const fullDiff = [...fileBlock("a.ts", 1), ...fileBlock("b.ts", 5), ...fileBlock("c.ts", 9)];

function apply(events: LiveEvent[], start: ReviewState = emptyReview) {
  let state = start;
  const effects = [];
  for (const ev of events) {
    const r = applyToReview(state, ev);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const persisted = (path: string, preview: string[]) =>
  ["<persisted-output>", `Output too large (40KB). Full output saved to: ${path}`, "", "Preview (first 2KB):", ...preview, "...", "</persisted-output>"].join("\n");

describe("applyToReview", () => {
  test("a saved diff plus two follow-up reads builds a three-file review", () => {
    const { state, effects } = apply([
      shell("gh pr diff https://github.com/acme/pay/pull/12", persisted("/tmp/out.txt", fullDiff.slice(0, 6))),
      read("/tmp/out.txt", fullDiff.slice(6, 12).join("\n"), 7, 6),
      read("/tmp/out.txt", fullDiff.slice(12).join("\n"), 13, 100),
    ]);
    const review = state.reviews[0];
    expect(review.label).toBe("acme/pay#12");
    expect(review.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(review.coverage.slice(0, 2).every((c) => !c.partial)).toBe(true);
    expect(state.mode).toBe("review");
    expect(effects.filter((e) => e.kind === "read-diff")).toEqual([
      { kind: "read-diff", reviewId: review.id, from: 1, to: 6 },
      { kind: "read-diff", reviewId: review.id, from: 7, to: 12 },
      { kind: "read-diff", reviewId: review.id, from: 13, to: 18 },
    ]);
  });

  test("a redirected diff read with sed is linked and merged", () => {
    const { state } = apply([
      shell("gh pr diff 12 > /tmp/pr.diff", ""),
      shell("sed -n '1,6p' /tmp/pr.diff", fullDiff.slice(0, 6).join("\n")),
      shell("sed -n '7,12p' /tmp/pr.diff", fullDiff.slice(6, 12).join("\n")),
    ]);
    expect(state.reviews[0].files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("reads of files that aren't linked are ignored", () => {
    const { state } = apply([shell("gh pr diff 12 > /tmp/pr.diff", ""), shell("cat other.txt", "hello")]);
    expect(state.reviews[0].files).toEqual([]);
  });

  test("a diff piped through grep creates no review", () => {
    expect(apply([shell("gh pr diff 12 | grep TODO", "x")]).state.reviews).toEqual([]);
  });

  test("gh pr view files are remembered", () => {
    const { state } = apply([
      shell("gh pr diff 12", fullDiff.slice(0, 6).join("\n")),
      shell("gh pr view 12 --json files", JSON.stringify({ files: [{ path: "a.ts", additions: 1, deletions: 1 }, { path: "z.ts", additions: 3, deletions: 0 }] })),
    ]);
    expect(state.reviews[0].allFiles).toEqual([
      { path: "a.ts", adds: 1, dels: 1 },
      { path: "z.ts", adds: 3, dels: 0 },
    ]);
  });

  test("a file fetched at PR head is kept and read", () => {
    const { state, effects } = apply([
      shell("gh pr diff 12", fullDiff.join("\n")),
      shell('gh api "repos/acme/pay/contents/src/a.ts?ref=abc" --jq .content | base64 -d', "export const a = 1;"),
    ]);
    expect(state.reviews[0].headFiles.get("src/a.ts")).toBe("export const a = 1;");
    expect(effects).toContainEqual({ kind: "read-file", reviewId: state.reviews[0].id, path: "src/a.ts" });
  });

  test("the final report attaches to its PR", () => {
    const report = "| PR | [acme/pay#12](u) · open |\n\n### Code findings\n#### 🔴 Critical\n1. `a.ts:1` — bad → fix\n\n### Verdict\nNot ready — x";
    const { state } = apply([shell("gh pr diff https://github.com/acme/pay/pull/12", fullDiff.join("\n")), message(report)]);
    expect(state.reviews[0].report?.verdict).toBe("not-ready");
    expect(state.reviews[0].report?.findings).toHaveLength(1);
  });

  test("mode follows the work until the user picks, then waits for a new review", () => {
    let { state } = apply([shell("gh pr diff 12", fullDiff.join("\n"))]);
    expect(state.mode).toBe("review");
    state = apply([edit()], state).state;
    expect(state.mode).toBe("code");
    state = setMode(state, "review");
    state = apply([edit()], state).state;
    expect(state.mode).toBe("review");
    state = setMode(state, "code");
    state = apply([shell("gh pr diff 13", fullDiff.join("\n"))], state).state;
    expect(state.mode).toBe("review");
    expect(state.manual).toBe(false);
  });

  test("replaying a finished review from history gives the same state", () => {
    const events = [
      shell("gh pr diff https://github.com/acme/pay/pull/12", persisted("/tmp/out.txt", fullDiff.slice(0, 6))),
      read("/tmp/out.txt", fullDiff.slice(6).join("\n"), 7, null),
      message("| PR | [acme/pay#12](u) |\n### Code findings\n#### 🟢 Low\n1. `b.ts:5` — naming → rename\n### Verdict\nReady to merge — ok"),
    ];
    const once = apply(events).state;
    const twice = apply(events, once).state;
    expect(twice.reviews).toHaveLength(1);
    expect(twice.reviews[0].files.map((f) => f.path)).toEqual(once.reviews[0].files.map((f) => f.path));
    expect(twice.reviews[0].report?.verdict).toBe("ready");
    expect(twice.mode).toBe("review");
  });
});
