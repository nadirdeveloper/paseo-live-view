/** Unified diff parsing for review mode. Lines may be `undefined` where the agent hasn't read yet. */

export type DiffLine = {
  kind: "context" | "add" | "del" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** 1-based line number in the diff text. */
  at: number;
};
export type DiffHunk = { header: string; oldStart: number; newStart: number; lines: DiffLine[]; at: number };
export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  adds: number;
  dels: number;
  hunks: DiffHunk[];
  at: number;
  endAt: number;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(lines: (string | undefined)[]): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo: number | null = null;
  let newNo: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    const line = lines[i];
    if (line === undefined) {
      // A gap: we no longer know the numbering inside this hunk.
      oldNo = null;
      newNo = null;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = {
        path: match ? match[2] : line.slice(11),
        oldPath: null,
        status: "modified",
        adds: 0,
        dels: 0,
        hunks: [],
        at,
        endAt: at,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    file.endAt = at;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.oldPath = line.slice(12);
        file.status = "renamed";
      } else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.status = "binary";
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    }
    const header = HUNK.exec(line);
    if (header) {
      hunk = { header: line, oldStart: Number(header[1]), newStart: Number(header[2]), lines: [], at };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+") {
      hunk.lines.push({ kind: "add", oldNo: null, newNo, text, at });
      file.adds++;
      if (newNo !== null) newNo++;
    } else if (mark === "-") {
      hunk.lines.push({ kind: "del", oldNo, newNo: null, text, at });
      file.dels++;
      if (oldNo !== null) oldNo++;
    } else if (mark === " " || line === "") {
      hunk.lines.push({ kind: "context", oldNo, newNo, text, at });
      if (oldNo !== null) oldNo++;
      if (newNo !== null) newNo++;
    } else {
      hunk.lines.push({ kind: "meta", oldNo: null, newNo: null, text: line, at });
    }
  }
  return files;
}
