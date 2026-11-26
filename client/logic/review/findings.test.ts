import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "./diff";
import { parseReport, placeFinding, type Finding } from "./findings";

const report = `## ME-14400 — Fix the payment retry

| Field | Value |
|-------|-------|
| Jira | [ME-14400](https://x.atlassian.net/browse/ME-14400) · Bug |
| PR | [acme/pay#12](https://github.com/acme/pay/pull/12) · open · +40 / −8 in 3 files |

### Needs your decision
- None.

### Code findings
Summary: 🔴 1 Critical · 🟠 1 High · 🟡 1 Medium · 🟢 1 Low

#### 🔴 Critical
1. \`src/a.ts:42\` — token is logged in plain text → remove the log line

#### 🟠 High
2. \`src/b.ts:12-30\` — **Decision needed:** retries never stop → cap at 3

#### 🟡 Medium
3. \`utils.ts:7\` — missing guard for empty list → return early

#### 🟢 Low
4. Naming is inconsistent across the module → rename later

### Discussion
- **Jira:** No comments.

### Verdict
Not ready — the critical log leak must be fixed first`;

describe("parseReport", () => {
  test("reads findings, severities, locations and the verdict", () => {
    const r = parseReport(report)!;
    expect(r.prs).toEqual(["acme/pay#12"]);
    expect(r.verdict).toBe("not-ready");
    expect(r.findings.map((f) => [f.n, f.severity, f.path, f.line, f.lineEnd, f.decisionNeeded])).toEqual([
      [1, "critical", "src/a.ts", 42, null, false],
      [2, "high", "src/b.ts", 12, 30, true],
      [3, "medium", "utils.ts", 7, null, false],
      [4, "low", null, null, null, false],
    ]);
    expect(r.findings[0].text).toBe("token is logged in plain text → remove the log line");
  });

  test("verdict variants", () => {
    expect(parseReport(report.replace(/Not ready —/, "Ready to merge —"))!.verdict).toBe("ready");
    expect(parseReport(report.replace(/Not ready —/, "Merge after fixes —"))!.verdict).toBe("after-fixes");
  });

  test("a message without code findings isn't a report", () => {
    expect(parseReport("Here is a summary of the PR.")).toBeNull();
  });
});

describe("placeFinding", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -40,3 +40,4 @@",
    " a",
    " b",
    "+console.log(token)",
    " c",
    "@@ -90,2 +91,1 @@",
    "-old one",
    " keep",
    "diff --git a/lib/utils.ts b/lib/utils.ts",
    "--- a/lib/utils.ts",
    "+++ b/lib/utils.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/app/utils.ts b/app/utils.ts",
    "--- a/app/utils.ts",
    "+++ b/app/utils.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ]);
  const finding = (path: string | null, line: number | null): Finding => ({
    n: 1, severity: "high", path, line, lineEnd: null, text: "x", decisionNeeded: false,
  });

  test("pins on the new line number in the diff", () => {
    expect(placeFinding(finding("src/a.ts", 42), files)).toEqual({ kind: "pinned", path: "src/a.ts", diffAt: 7 });
  });

  test("a line not in the diff pins to the nearest hunk of that file", () => {
    expect(placeFinding(finding("src/a.ts", 95), files)).toEqual({ kind: "pinned", path: "src/a.ts", diffAt: 9 });
  });

  test("a file outside the PR goes to the outside group", () => {
    expect(placeFinding(finding("src/caller.ts", 88), files)).toEqual({ kind: "outside", path: "src/caller.ts" });
  });

  test("a bare file name matching two PR files is listed, not guessed", () => {
    expect(placeFinding(finding("utils.ts", 1), files)).toEqual({ kind: "listed" });
  });

  test("a bare file name matching one PR file is pinned", () => {
    expect(placeFinding(finding("a.ts", 42), files)).toEqual({ kind: "pinned", path: "src/a.ts", diffAt: 7 });
  });

  test("no path is listed", () => {
    expect(placeFinding(finding(null, null), files)).toEqual({ kind: "listed" });
  });
});
