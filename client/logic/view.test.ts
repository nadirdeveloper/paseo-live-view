import { describe, expect, test } from "vitest";
import { clipLine, visibleWindow } from "./view";

describe("visibleWindow", () => {
  test("a file you opened yourself shows up to 3,000 lines from the top", () => {
    expect(visibleWindow({ lineCount: 400, focus: null, extraAbove: 0, extraBelow: 0 })).toEqual({ first: 1, last: 400 });
    expect(visibleWindow({ lineCount: 10000, focus: null, extraAbove: 0, extraBelow: 0 })).toEqual({ first: 1, last: 3000 });
  });

  test("while following, it shows 60 lines either side of the focus", () => {
    expect(visibleWindow({ lineCount: 1000, focus: 500, extraAbove: 0, extraBelow: 0 })).toEqual({ first: 440, last: 560 });
  });

  test("show-more extends the window", () => {
    expect(visibleWindow({ lineCount: 1000, focus: 500, extraAbove: 200, extraBelow: 200 })).toEqual({ first: 240, last: 760 });
  });

  test("never goes past the ends of the file", () => {
    expect(visibleWindow({ lineCount: 30, focus: 5, extraAbove: 0, extraBelow: 0 })).toEqual({ first: 1, last: 30 });
  });
});

describe("clipLine", () => {
  test("short lines are untouched", () => {
    expect(clipLine("hello", 2)).toEqual({ text: "hello", cursorColumn: 2 });
  });

  test("a huge line is clipped around the cursor with markers", () => {
    const line = "a".repeat(100000);
    const out = clipLine(line, 50000, 2000);
    expect(out.text.length).toBeLessThanOrEqual(2002);
    expect(out.text.startsWith("…")).toBe(true);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.cursorColumn).toBe(1001);
  });

  test("a huge line with no cursor shows its start", () => {
    const out = clipLine("b".repeat(5000), null, 2000);
    expect(out.text).toBe("b".repeat(2000) + "…");
    expect(out.cursorColumn).toBeNull();
  });
});
