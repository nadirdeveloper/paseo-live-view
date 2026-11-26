import { describe, expect, test } from "vitest";
import { addSegment, addTail, emptyDoc, filesOf } from "./sparse";

const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `L${from + i}`).join("\n");

describe("addSegment", () => {
  test("out-of-order, overlapping reads merge once", () => {
    let r = addSegment(emptyDoc, 400, numbered(400, 600));
    expect(r.added).toEqual({ from: 400, to: 600 });
    r = addSegment(r.doc, 1, numbered(1, 400));
    expect(r.added).toEqual({ from: 1, to: 399 });
    r = addSegment(r.doc, 550, numbered(550, 700));
    expect(r.added).toEqual({ from: 601, to: 700 });
    expect(r.doc.lines.filter((l) => l !== undefined)).toHaveLength(700);
    expect(r.doc.lines[699]).toBe("L700");
  });

  test("reading the same part again adds nothing", () => {
    const first = addSegment(emptyDoc, 1, numbered(1, 10)).doc;
    expect(addSegment(first, 1, numbered(1, 10)).added).toBeNull();
  });

  test("a trailing newline doesn't add an empty line", () => {
    expect(addSegment(emptyDoc, 1, "a\nb\n").doc.lines).toEqual(["a", "b"]);
  });

  test("a whole-file read sets the total line count", () => {
    expect(addSegment(emptyDoc, 1, numbered(1, 50), { isWholeFile: true }).doc.totalLines).toBe(50);
  });
});

describe("addTail", () => {
  test("is placed only once the total is known", () => {
    expect(addTail(emptyDoc, 5, numbered(46, 50)).added).toBeNull();
    const whole = { lines: [] as (string | undefined)[], totalLines: 50 };
    const r = addTail(whole, 5, numbered(46, 50));
    expect(r.added).toEqual({ from: 46, to: 50 });
  });
});

describe("filesOf", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-x",
    "+y",
    " z",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-p",
    "+q",
  ];

  test("full coverage when everything is read", () => {
    const doc = addSegment(emptyDoc, 1, diff.join("\n"), { isWholeFile: true }).doc;
    const { files, coverage } = filesOf(doc);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(coverage).toEqual([
      { path: "a.ts", known: 7, total: 7, partial: false },
      { path: "b.ts", known: 6, total: 6, partial: false },
    ]);
  });

  test("a file with an unread gap is partial", () => {
    let doc = addSegment(emptyDoc, 1, diff.slice(0, 4).join("\n")).doc;
    doc = addSegment(doc, 7, diff.slice(6).join("\n")).doc;
    const a = filesOf(doc).coverage[0];
    expect(a).toEqual({ path: "a.ts", known: 5, total: 7, partial: true });
  });

  test("the last file is partial while the end of the diff is unknown", () => {
    const doc = addSegment(emptyDoc, 1, diff.join("\n")).doc;
    expect(filesOf(doc).coverage[1]).toMatchObject({ path: "b.ts", partial: true, total: null });
  });
});
