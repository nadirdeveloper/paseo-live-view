import { parseUnifiedDiff, type DiffFile } from "./diff";

/** The diff file as far as the agent has read it: `undefined` marks lines not read yet. */
export type SparseDoc = { lines: (string | undefined)[]; totalLines: number | null };
export type FileCoverage = { path: string; known: number; total: number | null; partial: boolean };
type Added = { from: number; to: number } | null;

export const emptyDoc: SparseDoc = { lines: [], totalLines: null };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Place `text` starting at 1-based line `from`; report which lines were new. */
export function addSegment(doc: SparseDoc, from: number, text: string, opts: { isWholeFile?: boolean } = {}): { doc: SparseDoc; added: Added } {
  const incoming = splitLines(text);
  const lines = doc.lines.slice();
  let first = -1;
  let last = -1;
  incoming.forEach((line, i) => {
    const index = from - 1 + i;
    if (lines[index] === undefined) {
      if (first === -1) first = index + 1;
      last = index + 1;
    }
    lines[index] = line;
  });
  const totalLines = opts.isWholeFile ? incoming.length : doc.totalLines;
  if (first === -1) return { doc: opts.isWholeFile && totalLines !== doc.totalLines ? { lines, totalLines } : doc, added: null };
  return { doc: { lines, totalLines }, added: { from: first, to: last } };
}

/** Place the last `count` lines (from `tail -n`), which needs the total line count. */
export function addTail(doc: SparseDoc, count: number, text: string): { doc: SparseDoc; added: Added } {
  if (doc.totalLines === null) return { doc, added: null };
  const incoming = splitLines(text);
  return addSegment(doc, doc.totalLines - incoming.length + 1, text);
}

export function filesOf(doc: SparseDoc): { files: DiffFile[]; coverage: FileCoverage[] } {
  const files = parseUnifiedDiff(doc.lines);
  const coverage = files.map((file, i) => {
    const next = files[i + 1];
    const end = next ? next.at - 1 : doc.totalLines;
    const until = end ?? doc.lines.length;
    let known = 0;
    let gaps = false;
    for (let at = file.at; at <= until; at++) {
      if (doc.lines[at - 1] === undefined) gaps = true;
      else known++;
    }
    return { path: file.path, known, total: end === null ? null : end - file.at + 1, partial: gaps || end === null };
  });
  return { files, coverage };
}
