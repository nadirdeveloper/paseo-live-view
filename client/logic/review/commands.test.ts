import { describe, expect, test } from "vitest";
import { detectReviewCommand, parsePersisted } from "./commands";

describe("detectReviewCommand", () => {
  test("gh pr diff with a URL", () => {
    expect(detectReviewCommand("gh pr diff https://github.com/o/r/pull/12")).toEqual({
      kind: "pr-diff",
      pr: "https://github.com/o/r/pull/12",
      redirect: null,
      shown: true,
    });
  });

  test("gh pr diff redirected to a file", () => {
    expect(detectReviewCommand("gh pr diff 12 --color=never > /tmp/pr.diff")).toEqual({ kind: "pr-diff", pr: "12", redirect: "/tmp/pr.diff", shown: false });
  });

  test("gh pr diff through tee", () => {
    expect(detectReviewCommand("gh pr diff 12 | tee d.txt")).toEqual({ kind: "pr-diff", pr: "12", redirect: "d.txt", shown: true });
  });

  test("gh pr diff with a repo flag and no number", () => {
    expect(detectReviewCommand("cd x && gh pr diff --repo o/r")).toEqual({ kind: "pr-diff", pr: null, redirect: null, shown: true });
  });

  test("gh pr diff piped through grep is not the diff", () => {
    expect(detectReviewCommand("gh pr diff 12 | grep -n TODO")).toBeNull();
  });

  test("gh pr view with files", () => {
    expect(detectReviewCommand("gh pr view 12 --json files,title")).toEqual({ kind: "pr-view", pr: "12" });
    expect(detectReviewCommand("gh pr view 12 --json title")).toBeNull();
  });

  test("whole file fetched at PR head", () => {
    expect(detectReviewCommand('gh api "repos/o/r/contents/src/a.ts?ref=abc" --jq .content | base64 -d')).toEqual({
      kind: "file-at-head",
      repo: "o/r",
      path: "src/a.ts",
      ref: "abc",
    });
  });

  test("file fetches only count when gh api is the command and the decoded file is the output", () => {
    // Text inside a heredoc isn't a command.
    expect(detectReviewCommand("cat > t.ts <<'EOF'\ngh api \"repos/o/r/contents/src/big.ts?ref=x\" --jq .content | base64 -d\nEOF")).toBeNull();
    // Shell variables can't be resolved.
    expect(detectReviewCommand('for f in a b; do gh api "repos/o/r/contents/$f?ref=x" --jq .content | base64 -d; done')).toBeNull();
    // Filtered output isn't the file.
    expect(detectReviewCommand('gh api "repos/o/r/contents/amplify.yml?ref=x" --jq .content | base64 -d | grep env')).toBeNull();
    // A loop body with a literal path still counts.
    expect(detectReviewCommand('cd x && gh api "repos/o/r/contents/src/a.ts" --jq .content | base64 --decode')).toMatchObject({ kind: "file-at-head", path: "src/a.ts", ref: null });
  });

  test("reads of a file", () => {
    expect(detectReviewCommand("sed -n '400,600p' /tmp/pr.diff")).toEqual({ kind: "read-linked", path: "/tmp/pr.diff", range: { from: 400, to: 600 } });
    expect(detectReviewCommand("head -n 50 x.diff")).toEqual({ kind: "read-linked", path: "x.diff", range: { from: 1, to: 50 } });
    expect(detectReviewCommand("head -50 x.diff")).toEqual({ kind: "read-linked", path: "x.diff", range: { from: 1, to: 50 } });
    expect(detectReviewCommand("tail -n 20 x.diff")).toEqual({ kind: "read-linked", path: "x.diff", range: { tail: 20 } });
    expect(detectReviewCommand("cat x.diff")).toEqual({ kind: "read-linked", path: "x.diff", range: { from: 1, to: null } });
  });

  test("unrelated commands", () => {
    expect(detectReviewCommand("ls -la")).toBeNull();
    expect(detectReviewCommand("cat a b")).toBeNull();
  });
});

describe("parsePersisted", () => {
  const output = [
    "<persisted-output>",
    "Output too large (42.9KB). Full output saved to: /Users/x/tool-results/btogqsbyy.txt",
    "",
    "Preview (first 2KB):",
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "...",
    "</persisted-output>",
  ].join("\n");

  test("finds the saved path and the preview", () => {
    expect(parsePersisted(output)).toEqual({
      savedPath: "/Users/x/tool-results/btogqsbyy.txt",
      preview: "diff --git a/a.ts b/a.ts\n--- a/a.ts",
    });
  });

  test("normal output is not persisted", () => {
    expect(parsePersisted("diff --git a/a b/a")).toBeNull();
  });
});
