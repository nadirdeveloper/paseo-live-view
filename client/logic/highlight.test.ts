import { describe, expect, test } from "vitest";
import { START, languageFor, stateAfterLine, stateAt, tokenizeLine, type Token, type TokenKind } from "./highlight";

function kindsOf(tokens: Token[]): [string, TokenKind][] {
  return tokens.filter((t) => t.kind !== "plain" && t.text.trim() !== "").map((t) => [t.text, t.kind]);
}

describe("languageFor", () => {
  test("maps extensions to languages", () => {
    expect(languageFor("a/b.tsx")).toBe("js");
    expect(languageFor("script.js")).toBe("js");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("styles.css")).toBe("css");
    expect(languageFor("index.html")).toBe("html");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("run.sh")).toBe("shell");
  });

  test("unknown files are plain", () => {
    expect(languageFor("Makefile")).toBeNull();
    expect(languageFor("data.xyz")).toBeNull();
  });
});

describe("tokenizeLine (js)", () => {
  test("keywords, strings and line comments", () => {
    const { tokens } = tokenizeLine("const x = 'a' // hi", "js", START);
    expect(kindsOf(tokens)).toEqual(
      expect.arrayContaining([
        ["const", "keyword"],
        ["'a'", "string"],
        ["// hi", "comment"],
      ]),
    );
  });

  test("function calls and numbers", () => {
    const { tokens } = tokenizeLine("foo(1.5)", "js", START);
    expect(kindsOf(tokens)).toEqual(expect.arrayContaining([["foo", "function"], ["1.5", "number"]]));
  });

  test("capitalised names are types", () => {
    const { tokens } = tokenizeLine("new Map()", "js", START);
    expect(kindsOf(tokens)).toEqual(expect.arrayContaining([["new", "keyword"], ["Map", "type"]]));
  });

  test("a block comment carries over to the next line", () => {
    const first = tokenizeLine("a /* start", "js", START);
    expect(first.state.mode).toBe("blockComment");
    const second = tokenizeLine("end */ const", "js", first.state);
    expect(second.tokens[0]).toEqual({ text: "end */", kind: "comment" });
    expect(kindsOf(second.tokens)).toContainEqual(["const", "keyword"]);
    expect(second.state.mode).toBe("normal");
  });

  test("a template string carries over to the next line", () => {
    const first = tokenizeLine("const s = `a", "js", START);
    expect(first.state.mode).toBe("template");
    const second = tokenizeLine("b` + 1", "js", first.state);
    expect(second.tokens[0]).toEqual({ text: "b`", kind: "string" });
  });

  test("tokens always join back to the exact line", () => {
    for (const line of ["  var pickedIndex = Math.floor(rng() * names.length);", "if (a) { return \"x\\\"y\"; }", ""]) {
      expect(tokenizeLine(line, "js", START).tokens.map((t) => t.text).join("")).toBe(line);
    }
  });
});

describe("other languages", () => {
  test("css properties and values", () => {
    const { tokens } = tokenizeLine("  color: #fff; margin: 4px;", "css", START);
    expect(kindsOf(tokens)).toEqual(expect.arrayContaining([["color", "property"], ["#fff", "number"], ["4px", "number"]]));
  });

  test("html tags, attributes and values", () => {
    const { tokens } = tokenizeLine('<div class="x">hi</div>', "html", START);
    expect(kindsOf(tokens)).toEqual(expect.arrayContaining([["div", "tag"], ["class", "attr"], ['"x"', "string"]]));
  });

  test("json keys and values", () => {
    const { tokens } = tokenizeLine('  "name": "who", "n": 3, "ok": true', "json", START);
    expect(kindsOf(tokens)).toEqual(
      expect.arrayContaining([['"name"', "property"], ['"who"', "string"], ["3", "number"], ["true", "keyword"]]),
    );
  });

  test("markdown headings and code", () => {
    expect(kindsOf(tokenizeLine("# Title", "markdown", START).tokens)).toContainEqual(["# Title", "keyword"]);
    expect(kindsOf(tokenizeLine("use `pnpm` here", "markdown", START).tokens)).toContainEqual(["`pnpm`", "string"]);
  });

  test("shell comments, strings and variables", () => {
    const { tokens } = tokenizeLine('echo "$HOME" # done', "shell", START);
    expect(kindsOf(tokens)).toEqual(expect.arrayContaining([["echo", "function"], ['"$HOME"', "string"], ["# done", "comment"]]));
  });
});

describe("long lines", () => {
  test("a 130 KB line of minified CSS tokenizes quickly", () => {
    const css = ".a{color:red;margin:0 auto}".repeat(5000);
    const start = performance.now();
    const { tokens } = tokenizeLine(css, "css", START);
    expect(performance.now() - start).toBeLessThan(100);
    expect(tokens.map((t) => t.text).join("")).toBe(css);
    expect(tokens).toContainEqual({ text: "color", kind: "property" });
  });

  test("stateAfterLine gives the next line's state without building tokens", () => {
    expect(stateAfterLine("a /* open", "js", START).mode).toBe("blockComment");
    expect(stateAfterLine("x */ y", "js", { mode: "blockComment" }).mode).toBe("normal");
    expect(stateAfterLine("{}", "json", START)).toEqual(START);
  });
});

describe("stateAt", () => {
  test("knows a window starts inside a block comment", () => {
    const lines = ["x", "/* open", "still", "*/ y"];
    expect(stateAt(lines, "js", 2).mode).toBe("blockComment");
    expect(stateAt(lines, "js", 0).mode).toBe("normal");
  });

  test("is fast enough on a 10,000 line file", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `const v${i} = foo(${i}, "s"); // note`);
    stateAt(lines, "js", 9990);
    const start = performance.now();
    let state = stateAt(lines, "js", 9880);
    for (let i = 9880; i < 10000; i++) state = tokenizeLine(lines[i], "js", state).state;
    expect(performance.now() - start).toBeLessThan(50);
  });
});
