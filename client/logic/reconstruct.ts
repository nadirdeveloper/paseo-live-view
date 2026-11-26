export type Reconstruction =
  | { mode: "replay"; before: string; offset: number; oldText: string; newText: string; startLine: number }
  | { mode: "diff-only"; after: string; changedLines: number[] }
  | { mode: "standalone"; oldText: string; newText: string; reason: "not-found" | "no-snapshot" | "ambiguous" };

export type ReconstructInput = {
  afterText: string | null | undefined;
  oldString?: string;
  newString?: string;
  unifiedDiff?: string;
  hintLine?: number;
};

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 1-based line numbers, in the new file, of every added line in a unified diff. */
export function addedLines(unifiedDiff: string): number[] {
  const added: number[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of unifiedDiff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added.push(newLine++);
    else if (line.startsWith(" ")) newLine++;
    // "-" lines and "\ No newline" markers don't exist in the new file.
  }
  return added;
}

export function reconstructEdit(input: ReconstructInput): Reconstruction {
  const { afterText, oldString, newString, unifiedDiff, hintLine } = input;
  const hasStrings = oldString !== undefined || newString !== undefined;

  if (!hasStrings && unifiedDiff !== undefined && afterText != null) {
    return { mode: "diff-only", after: afterText, changedLines: addedLines(unifiedDiff) };
  }

  const oldText = oldString ?? "";
  const newText = newString ?? "";
  if (afterText == null) return { mode: "standalone", oldText, newText, reason: "no-snapshot" };
  // An empty new text matches everywhere, so a pure deletion can't be placed.
  if (newText === "") return { mode: "standalone", oldText, newText, reason: "not-found" };

  const matches: number[] = [];
  for (let at = afterText.indexOf(newText); at !== -1; at = afterText.indexOf(newText, at + 1)) {
    matches.push(at);
  }
  if (matches.length === 0) return { mode: "standalone", oldText, newText, reason: "not-found" };

  // Several matches and nothing to say which one changed: guessing could show text that never existed.
  if (matches.length > 1 && hintLine === undefined) return { mode: "standalone", oldText, newText, reason: "ambiguous" };

  let offset = matches[0];
  if (hintLine !== undefined && matches.length > 1) {
    let best = Infinity;
    for (const at of matches) {
      const distance = Math.abs(lineAt(afterText, at) - hintLine);
      if (distance < best) {
        best = distance;
        offset = at;
      }
    }
  }

  const before = afterText.slice(0, offset) + oldText + afterText.slice(offset + newText.length);
  return { mode: "replay", before, offset, oldText, newText, startLine: lineAt(afterText, offset) };
}
