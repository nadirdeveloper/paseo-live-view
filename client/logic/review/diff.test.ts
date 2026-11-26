import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "./diff";

const twoFiles = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+ten and a half",
  " eleven",
  "diff --git a/new.md b/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.md",
  "@@ -0,0 +1,2 @@",
  "+# New",
  "+text",
];

describe("parseUnifiedDiff", () => {
  test("two files with hunks, numbers and positions", () => {
    const files = parseUnifiedDiff(twoFiles);
    expect(files.map((f) => [f.path, f.status, f.adds, f.dels])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["new.md", "added", 2, 0],
    ]);
    const a = files[0];
    expect(a.at).toBe(1);
    expect(a.endAt).toBe(13);
    expect(a.hunks).toHaveLength(2);
    expect(a.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, at: 5 });
    expect(a.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["add", null, 2, "TWO"],
      ["context", 3, 3, "three"],
    ]);
    expect(a.hunks[1].lines[1]).toMatchObject({ kind: "add", newNo: 11, at: 12 });
    expect(files[1].at).toBe(14);
  });

  test("renames", () => {
    const files = parseUnifiedDiff([
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
    ]);
    expect(files[0]).toMatchObject({ path: "new.ts", oldPath: "old.ts", status: "renamed" });
  });

  test("deleted and binary files", () => {
    const files = parseUnifiedDiff([
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ]);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["gone.ts", "deleted"],
      ["logo.png", "binary"],
    ]);
  });

  test("gaps (lines not read yet) are skipped without breaking numbering of later hunks", () => {
    const lines: (string | undefined)[] = [...twoFiles];
    lines[10] = undefined;
    lines[11] = undefined;
    const files = parseUnifiedDiff(lines);
    expect(files[0].hunks[1].lines.map((l) => l.text)).toEqual(["eleven"]);
    expect(files[0].hunks[1].lines[0]).toMatchObject({ at: 13 });
    expect(files[1].path).toBe("new.md");
  });
});
