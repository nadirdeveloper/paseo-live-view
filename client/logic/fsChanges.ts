import type { FileChange } from "../../shared/files";
import type { EditEvent, LiveEvent, WriteEvent } from "./events";

export const MAX_TYPED_HUNKS = 12;
export const MAX_TYPED_LINES = 400;
/** Above this many cells the line diff gives up and treats the changed middle as one block. */
const MAX_DIFF_CELLS = 2_000_000;

type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number };
type Base = { key: string; agentId: string; agentLabel: string; at: string };

/** Lines with their line breaks, so joined pieces are exact substrings of the file. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Changed blocks between two line lists (common prefix/suffix, then an LCS on the middle). */
export function lineHunks(a: string[], b: string[]): Hunk[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);
  if (aMid.length === 0 && bMid.length === 0) return [];
  const m = aMid.length;
  const n = bMid.length;
  if (m === 0 || n === 0 || (m + 1) * (n + 1) > MAX_DIFF_CELLS) {
    return [{ aStart: p, aEnd: p + m, bStart: p, bEnd: p + n }];
  }
  // lcs[i][j] = LCS length of aMid[i..] and bMid[j..]
  const width = n + 1;
  const lcs = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i * width + j] = aMid[i] === bMid[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < m || j < n) {
    if (i < m && j < n && aMid[i] === bMid[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { aStart: p + i, aEnd: p + i, bStart: p + j, bEnd: p + j };
      if (j < n && (i >= m || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
        j++;
        open.bEnd = p + j;
      } else {
        i++;
        open.aEnd = p + i;
      }
    }
  }
  close();
  return hunks;
}

function unifiedDiff(a: string[], b: string[], hunks: Hunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart + 1},${h.aEnd - h.aStart} +${h.bStart + 1},${h.bEnd - h.bStart} @@`);
    for (let k = h.aStart; k < h.aEnd; k++) out.push("-" + a[k].replace(/\n$/, ""));
    for (let k = h.bStart; k < h.bEnd; k++) out.push("+" + b[k].replace(/\n$/, ""));
  }
  return out.join("\n");
}

/**
 * A file change seen by the workspace watcher → events the player can replay: one typed edit per
 * changed block (a new file is typed like a write), or one highlighted edit when the change is huge.
 */
export function changeToEvents(change: FileChange, base: Base): LiveEvent[] {
  const { path, before, after } = change;
  const common = { ...base, status: "completed" as const, filePath: path, inWorkspace: true };
  if (after === null) return [];
  if (before === null) {
    const write: WriteEvent = { ...common, key: `${base.key}:fs:${path}`, kind: "write", content: after, afterText: after };
    return [write];
  }
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  const hunks = lineHunks(a, b);
  if (hunks.length === 0) return [];
  const changed = hunks.reduce((sum, h) => sum + Math.max(h.aEnd - h.aStart, h.bEnd - h.bStart), 0);
  if (hunks.length > MAX_TYPED_HUNKS || changed > MAX_TYPED_LINES) {
    const edit: EditEvent = { ...common, key: `${base.key}:fs:${path}:0`, kind: "edit", unifiedDiff: unifiedDiff(a, b, hunks), afterText: after };
    return [edit];
  }
  return hunks.map((h, index) => {
    // The file right after this block changed: blocks before it are applied, blocks after are not.
    const afterText = b.slice(0, h.bEnd).join("") + a.slice(h.aEnd).join("");
    let oldLines = a.slice(h.aStart, h.aEnd);
    let newLines = b.slice(h.bStart, h.bEnd);
    let line = h.bStart + 1;
    if (newLines.length === 0) {
      // A pure deletion has no new text to find; carry a neighbouring unchanged line along.
      if (h.aEnd < a.length) {
        oldLines = [...oldLines, a[h.aEnd]];
        newLines = [a[h.aEnd]];
      } else if (h.bStart > 0) {
        oldLines = [b[h.bStart - 1], ...oldLines];
        newLines = [b[h.bStart - 1]];
        line = h.bStart;
      }
    }
    const edit: EditEvent = {
      ...common,
      key: `${base.key}:fs:${path}:${index}`,
      kind: "edit",
      oldString: oldLines.join(""),
      newString: newLines.join(""),
      afterText,
      line,
    };
    return edit;
  });
}
