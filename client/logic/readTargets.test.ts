import { describe, expect, test } from "vitest";
import type { LiveEvent } from "./events";
import { readTargets, resolveSpecs } from "./readTargets";

const base = { key: "k", agentId: "a", agentLabel: "claude", at: "", status: "completed" as const };
const shell = (command: string, output = ""): LiveEvent => ({ ...base, kind: "shell", command, output, hiddenLines: 0, exitCode: 0 });
const reads = (command: string, output = "") => readTargets(shell(command, output), "/w").reads;

describe("readTargets: shell commands", () => {
  test("cat reads whole files", () => {
    expect(reads("cat script.js styles.css")).toEqual([
      { path: "/w/script.js", specs: [{ from: 1, to: "end" }] },
      { path: "/w/styles.css", specs: [{ from: 1, to: "end" }] },
    ]);
  });

  test("bat and nl read whole files, ignoring flags", () => {
    expect(reads("bat --style=plain a.js")).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
    expect(reads("nl -ba a.js")).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
  });

  test("head reads the first lines (10 by default)", () => {
    expect(reads("head -n 25 a.js")[0].specs).toEqual([{ from: 1, to: 25 }]);
    expect(reads("head -40 a.js")[0].specs).toEqual([{ from: 1, to: 40 }]);
    expect(reads("head a.js")[0].specs).toEqual([{ from: 1, to: 10 }]);
  });

  test("tail reads the last lines, or from a line with +N", () => {
    expect(reads("tail -n 5 a.js")[0].specs).toEqual([{ last: 5 }]);
    expect(reads("tail a.js")[0].specs).toEqual([{ last: 10 }]);
    expect(reads("tail -n +30 a.js")[0].specs).toEqual([{ from: 30, to: "end" }]);
  });

  test("sed -n prints line ranges", () => {
    expect(reads("sed -n '10,40p' a.js")[0].specs).toEqual([{ from: 10, to: 40 }]);
    expect(reads("sed -n 7p a.js")[0].specs).toEqual([{ from: 7, to: 7 }]);
    expect(reads("sed -n '5,$p' a.js")[0].specs).toEqual([{ from: 5, to: "end" }]);
    expect(reads("sed -n '5,+3p' a.js")[0].specs).toEqual([{ from: 5, to: 8 }]);
    expect(reads("sed -n -e '1,2p' -e '9p' a.js")[0].specs).toEqual([{ from: 1, to: 2 }, { from: 9, to: 9 }]);
  });

  test("sed -i edits rather than reads", () => {
    expect(reads("sed -i '' 's/a/b/' a.js")).toEqual([]);
  });

  test("awk NR conditions read line ranges", () => {
    expect(reads("awk 'NR>=3 && NR<=9' a.js")[0].specs).toEqual([{ from: 3, to: 9 }]);
    expect(reads("awk 'NR==4' a.js")[0].specs).toEqual([{ from: 4, to: 4 }]);
  });

  test("grep on one file uses the line numbers it printed", () => {
    expect(reads("grep -n pick script.js", "32:function pickRandom(names) {\n33:  var pickedIndex = 1;")).toEqual([
      { path: "/w/script.js", specs: [{ lines: [32, 33] }] },
    ]);
  });

  test("grep on one file without line numbers matches the printed lines", () => {
    expect(reads("grep pick script.js", "function pickRandom(names) {")).toEqual([
      { path: "/w/script.js", specs: [{ match: ["function pickRandom(names) {"] }] },
    ]);
  });

  test("recursive grep and rg group hits by file", () => {
    expect(reads("grep -rn pick .", "./script.js:32:function pick\n./tests/logic.test.js:5:pick()\n./script.js:40:pick")).toEqual([
      { path: "/w/script.js", specs: [{ lines: [32, 40] }] },
      { path: "/w/tests/logic.test.js", specs: [{ lines: [5] }] },
    ]);
    expect(reads("rg pick src", "src/a.ts:pick it")).toEqual([{ path: "/w/src/a.ts", specs: [{ match: ["pick it"] }] }]);
  });

  test("grep -l lists files to glance at", () => {
    expect(readTargets(shell("grep -rl pick .", "./script.js\n./a.css"), "/w")).toEqual({ reads: [], glance: ["/w/script.js", "/w/a.css"] });
  });

  test("cd before the command changes where paths resolve", () => {
    expect(reads("cd sub && cat x.js")).toEqual([{ path: "/w/sub/x.js", specs: [{ from: 1, to: "end" }] }]);
    expect(reads("cd /other/dir; cat x.js")[0].path).toBe("/other/dir/x.js");
  });

  test("quoted paths with spaces", () => {
    expect(reads(`cat "my file.txt"`)[0].path).toBe("/w/my file.txt");
    expect(reads("sed -n '5,9p' 'a b.js'")[0]).toEqual({ path: "/w/a b.js", specs: [{ from: 5, to: 9 }] });
  });

  test("the first part of a pipe is read; redirections are not files", () => {
    expect(reads("cat a.js | grep foo")).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
    expect(reads("cat a.js 2>&1")).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
  });

  test("writing with cat and a heredoc is not a read", () => {
    expect(reads("cat > out.txt <<'EOF'\nhello\nEOF")).toEqual([]);
  });

  test("a python heredoc's body is not parsed as commands", () => {
    expect(reads("python3 - <<'EOF'\ncat = open('x').read()\nEOF")).toEqual([]);
  });

  test("at most 3 files are read", () => {
    expect(reads("cat a b c d e")).toHaveLength(3);
  });
});

describe("readTargets: tools", () => {
  test("the Read tool reads from offset for limit lines", () => {
    const ev: LiveEvent = { ...base, kind: "read", filePath: "/w/a.js", content: "", offset: 20, limit: 10 };
    expect(readTargets(ev, "/w").reads).toEqual([{ path: "/w/a.js", specs: [{ from: 20, to: 29 }] }]);
  });

  test("the Read tool without offset reads the whole file", () => {
    const ev: LiveEvent = { ...base, kind: "read", filePath: "/w/a.js", content: "", offset: null, limit: null };
    expect(readTargets(ev, "/w").reads).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
  });

  test("a Grep tool with matching lines reads the hit lines", () => {
    const ev: LiveEvent = { ...base, kind: "search", toolName: "grep", query: "pick", content: "/w/script.js:32:function pick", filePaths: [], mode: "content" };
    expect(readTargets(ev, "/w").reads).toEqual([{ path: "/w/script.js", specs: [{ lines: [32] }] }]);
  });

  test("Grep file lists and Glob glance at the files", () => {
    const ev: LiveEvent = { ...base, kind: "search", toolName: "glob", query: "*.css", filePaths: ["/w/a.css", "/w/b.css"] };
    expect(readTargets(ev, "/w")).toEqual({ reads: [], glance: ["/w/a.css", "/w/b.css"] });
  });

  test("MCP read_file and read_multiple_files read whole files", () => {
    const one: LiveEvent = { ...base, kind: "other", name: "mcp__filesystem__read_text_file", input: { path: "a.js" } };
    const many: LiveEvent = { ...base, kind: "other", name: "mcp__filesystem__read_multiple_files", input: { paths: ["/w/a.js", "/w/b.js"] } };
    expect(readTargets(one, "/w").reads).toEqual([{ path: "/w/a.js", specs: [{ from: 1, to: "end" }] }]);
    expect(readTargets(many, "/w").reads.map((r) => r.path)).toEqual(["/w/a.js", "/w/b.js"]);
  });

  test("an edit is not a read", () => {
    const ev: LiveEvent = { ...base, kind: "edit", filePath: "/w/a.js", inWorkspace: true };
    expect(readTargets(ev, "/w")).toEqual({ reads: [], glance: [] });
  });
});

describe("resolveSpecs", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  test("clips to the file and caps a range at 80 lines", () => {
    expect(resolveSpecs([{ from: 1, to: "end" }], text)).toEqual([{ from: 1, to: 80 }]);
    expect(resolveSpecs([{ from: 190, to: 500 }], text)).toEqual([{ from: 190, to: 200 }]);
  });

  test("tail counts from the end of the file", () => {
    expect(resolveSpecs([{ last: 5 }], text)).toEqual([{ from: 196, to: 200 }]);
  });

  test("merges overlapping and adjacent ranges, in order", () => {
    expect(resolveSpecs([{ lines: [12, 10, 11] }, { from: 5, to: 9 }, { from: 50, to: 52 }], text)).toEqual([
      { from: 5, to: 12 },
      { from: 50, to: 52 },
    ]);
  });

  test("match finds printed lines by content", () => {
    expect(resolveSpecs([{ match: ["line 42", "line 7"] }], text)).toEqual([
      { from: 7, to: 7 },
      { from: 42, to: 42 },
    ]);
  });

  test("ranges outside the file disappear", () => {
    expect(resolveSpecs([{ from: 300, to: 310 }], text)).toEqual([]);
  });

  test("keeps at most 8 ranges", () => {
    expect(resolveSpecs([{ lines: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19] }], text)).toHaveLength(8);
  });
});
