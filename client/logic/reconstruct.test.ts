import { describe, expect, test } from "vitest";
import { reconstructEdit } from "./reconstruct";

describe("reconstructEdit", () => {
  test("puts the old text back where the new text is", () => {
    expect(reconstructEdit({ afterText: "a\nNEW\nc", oldString: "OLD", newString: "NEW" })).toEqual({
      mode: "replay",
      before: "a\nOLD\nc",
      offset: 2,
      oldText: "OLD",
      newText: "NEW",
      startLine: 2,
    });
  });

  test("with several matches picks the one nearest the hint line", () => {
    const lines = ["x", "NEW", "x", "x", "x", "x", "x", "x", "NEW", "x"];
    const result = reconstructEdit({ afterText: lines.join("\n"), oldString: "OLD", newString: "NEW", hintLine: 8 });
    expect(result).toMatchObject({ mode: "replay", startLine: 9 });
  });

  test("with several matches and no hint it can't tell which, so it falls back", () => {
    const result = reconstructEdit({ afterText: "y\nfoo\ny\n", oldString: "x = 1", newString: "y" });
    expect(result).toEqual({ mode: "standalone", oldText: "x = 1", newText: "y", reason: "ambiguous" });
  });

  test("falls back when the new text is no longer in the file", () => {
    expect(reconstructEdit({ afterText: "a\nb", oldString: "OLD", newString: "NEW" })).toEqual({
      mode: "standalone",
      oldText: "OLD",
      newText: "NEW",
      reason: "not-found",
    });
  });

  test("falls back when there is no file snapshot", () => {
    expect(reconstructEdit({ afterText: null, oldString: "OLD", newString: "NEW" })).toMatchObject({
      mode: "standalone",
      reason: "no-snapshot",
    });
  });

  test("a CRLF file with LF edit strings falls back without throwing", () => {
    expect(reconstructEdit({ afterText: "a\r\nNEW\r\nc", oldString: "OLD\nc", newString: "NEW\nc" })).toMatchObject({
      mode: "standalone",
      reason: "not-found",
    });
  });

  test("a pure deletion cannot be located and falls back", () => {
    expect(reconstructEdit({ afterText: "ac", oldString: "b", newString: "" })).toMatchObject({
      mode: "standalone",
    });
  });

  test("a diff-only edit highlights the added lines", () => {
    const unifiedDiff = ["--- a/f", "+++ b/f", "@@ -1,2 +1,3 @@", " one", "+two", " three"].join("\n");
    expect(reconstructEdit({ afterText: "one\ntwo\nthree", unifiedDiff })).toEqual({
      mode: "diff-only",
      after: "one\ntwo\nthree",
      changedLines: [2],
    });
  });

  test("a diff with several hunks counts lines from each header", () => {
    const unifiedDiff = ["@@ -1,1 +1,2 @@", " a", "+b", "@@ -10,2 +11,2 @@", "-x", "+y", " z"].join("\n");
    expect(reconstructEdit({ afterText: "", unifiedDiff })).toMatchObject({ changedLines: [2, 11] });
  });
});
