import type { DiffFile } from "./diff";

/** Parses the `review-as-leader` report and works out where each finding belongs. */

export type Severity = "critical" | "high" | "medium" | "low";
export type Finding = {
  n: number;
  severity: Severity;
  path: string | null;
  line: number | null;
  lineEnd: number | null;
  text: string;
  decisionNeeded: boolean;
};
export type Report = { prs: string[]; verdict: "ready" | "after-fixes" | "not-ready" | null; findings: Finding[] };
export type Placement = { kind: "pinned"; path: string; diffAt: number } | { kind: "outside"; path: string } | { kind: "listed" };

const SECTIONS: [RegExp, Severity][] = [
  [/^####\s*🔴/, "critical"],
  [/^####\s*🟠/, "high"],
  [/^####\s*🟡/, "medium"],
  [/^####\s*🟢/, "low"],
];

export function parseReport(markdown: string): Report | null {
  if (!markdown.includes("### Code findings")) return null;
  const lines = markdown.split("\n");
  const prs: string[] = [];
  for (const line of lines) {
    const row = /^\|\s*PR\s*\|(.*)\|\s*$/.exec(line);
    if (row) for (const match of row[1].matchAll(/\[([^\]]+#\d+)\]/g)) prs.push(match[1]);
  }

  const findings: Finding[] = [];
  let severity: Severity | null = null;
  let inFindings = false;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      inFindings = line.startsWith("### Code findings");
      severity = null;
      continue;
    }
    if (!inFindings) continue;
    const section = SECTIONS.find(([pattern]) => pattern.test(line));
    if (section) {
      severity = section[1];
      continue;
    }
    const item = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (!item || !severity) continue;
    let body = item[2];
    let path: string | null = null;
    let lineNo: number | null = null;
    let lineEnd: number | null = null;
    const location = /^`([^`:]+)(?::(\d+)(?:-(\d+))?)?`\s*(?:—|-|–)\s*/.exec(body);
    if (location) {
      path = location[1];
      lineNo = location[2] ? Number(location[2]) : null;
      lineEnd = location[3] ? Number(location[3]) : null;
      body = body.slice(location[0].length);
    }
    const decisionNeeded = /^\*\*Decision needed:\*\*\s*/.test(body);
    if (decisionNeeded) body = body.replace(/^\*\*Decision needed:\*\*\s*/, "");
    findings.push({ n: Number(item[1]), severity, path, line: lineNo, lineEnd, text: body.trim(), decisionNeeded });
  }

  let verdict: Report["verdict"] = null;
  const at = lines.findIndex((l) => l.startsWith("### Verdict"));
  const verdictLine = at === -1 ? "" : lines.slice(at + 1).find((l) => l.trim() !== "") ?? "";
  if (/^\s*Not ready/i.test(verdictLine)) verdict = "not-ready";
  else if (/^\s*Merge after fixes/i.test(verdictLine)) verdict = "after-fixes";
  else if (/^\s*Ready to merge/i.test(verdictLine)) verdict = "ready";

  return { prs, verdict, findings };
}

/** Where a finding goes: on a diff line, in the "Outside this PR" group, or in the list. */
export function placeFinding(f: Finding, files: DiffFile[]): Placement {
  if (!f.path) return { kind: "listed" };
  const p = f.path.replace(/^\.?\//, "");
  const candidates = files.filter((file) => file.path === p || file.path.endsWith("/" + p));
  if (candidates.length > 1) return { kind: "listed" };
  if (candidates.length === 0) return { kind: "outside", path: p };
  const file = candidates[0];
  if (f.line !== null) {
    for (const hunk of file.hunks) {
      const hit = hunk.lines.find((l) => l.newNo === f.line && l.kind !== "del");
      if (hit) return { kind: "pinned", path: file.path, diffAt: hit.at };
    }
    // Not in the diff (or deleted code): the hunk nearest that line.
    let best = file.hunks[0];
    for (const hunk of file.hunks) {
      if (Math.abs(hunk.newStart - f.line) < Math.abs(best.newStart - f.line)) best = hunk;
    }
    if (best) return { kind: "pinned", path: file.path, diffAt: best.at };
  }
  return { kind: "pinned", path: file.path, diffAt: file.at };
}
