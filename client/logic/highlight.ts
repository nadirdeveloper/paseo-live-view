/**
 * A small, dependency-free syntax tokenizer for the editor. Plugins can't load a third-party
 * highlighter, so this covers the file types the user works with: good-enough colours, never
 * exact parsing. Every line's tokens join back to the exact line.
 */

export type Lang = "js" | "json" | "css" | "html" | "markdown" | "shell";
export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "tag"
  | "attr"
  | "property"
  | "punctuation";
export type Token = { text: string; kind: TokenKind };
export type LexState = { mode: "normal" | "blockComment" | "template" | "htmlComment" };

export const START: LexState = { mode: "normal" };

const EXTENSIONS: Record<string, Lang> = {
  js: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  svg: "html",
  md: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

export function languageFor(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

const JS_KEYWORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else export extends finally for from " +
    "function if import in instanceof let new of return static super switch this throw try typeof var void " +
    "while with yield async await interface type enum implements private public protected readonly as " +
    "true false null undefined"
  ).split(" "),
);

const SHELL_KEYWORDS = new Set("if then else elif fi for in do done while case esac function return export local".split(" "));

/** Builds a token list, merging neighbours of the same kind. */
class Tokens {
  list: Token[] = [];
  push(text: string, kind: TokenKind) {
    if (!text) return;
    const last = this.list[this.list.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.list.push({ text, kind });
  }
}

/** Index just past the closing `quote` (honouring backslash escapes), or -1 when the line ends first. */
function closeQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === quote) return i + 1;
  }
  return -1;
}

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/;
const PUNCT = /^[{}()[\];,.:=+\-*/%!<>&|?^~]/;

function tokenizeJs(line: string, state: LexState): { tokens: Token[]; state: LexState } {
  const out = new Tokens();
  let i = 0;
  let mode = state.mode;
  if (mode === "blockComment") {
    const end = line.indexOf("*/");
    if (end === -1) return { tokens: [{ text: line, kind: "comment" }], state };
    out.push(line.slice(0, end + 2), "comment");
    i = end + 2;
    mode = "normal";
  } else if (mode === "template") {
    const end = closeQuote(line, 0, "`");
    if (end === -1) return { tokens: line ? [{ text: line, kind: "string" }] : [], state };
    out.push(line.slice(0, end), "string");
    i = end;
    mode = "normal";
  }
  while (i < line.length) {
    const rest = line.slice(i, i + 256); // bounded: patterns only look a short way ahead
    const ch = line[i];
    if (rest.startsWith("//")) {
      out.push(line.slice(i), "comment");
      break;
    }
    if (rest.startsWith("/*")) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        out.push(line.slice(i), "comment");
        mode = "blockComment";
        break;
      }
      out.push(line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = closeQuote(line, i + 1, ch);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop), "string");
      i = stop;
      continue;
    }
    if (ch === "`") {
      const end = closeQuote(line, i + 1, "`");
      if (end === -1) {
        out.push(line.slice(i), "string");
        mode = "template";
        break;
      }
      out.push(line.slice(i, end), "string");
      i = end;
      continue;
    }
    const prev = i > 0 ? line[i - 1] : " ";
    const number = /[\w$]/.test(prev) ? null : NUMBER.exec(rest);
    if (number) {
      out.push(number[0], "number");
      i += number[0].length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) {
      const word = ident[0];
      const after = line.slice(i + word.length, i + word.length + 64);
      let kind: TokenKind = "plain";
      if (JS_KEYWORDS.has(word)) kind = "keyword";
      else if (/^[A-Z]/.test(word)) kind = "type";
      else if (/^\s*\(/.test(after)) kind = "function";
      out.push(word, kind);
      i += word.length;
      continue;
    }
    out.push(ch, PUNCT.test(ch) ? "punctuation" : "plain");
    i++;
  }
  return { tokens: out.list, state: { mode } };
}

function tokenizeJson(line: string): Token[] {
  const out = new Tokens();
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const rest = line.slice(i, i + 256); // bounded: patterns only look a short way ahead
    if (ch === '"') {
      const end = closeQuote(line, i + 1, '"');
      const stop = end === -1 ? line.length : end;
      const isKey = /^\s*:/.test(line.slice(stop));
      out.push(line.slice(i, stop), isKey ? "property" : "string");
      i = stop;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      out.push(number[0], "number");
      i += number[0].length;
      continue;
    }
    const word = /^(true|false|null)\b/.exec(rest);
    if (word) {
      out.push(word[0], "keyword");
      i += word[0].length;
      continue;
    }
    out.push(ch, /[{}[\],:]/.test(ch) ? "punctuation" : "plain");
    i++;
  }
  return out.list;
}

function tokenizeCss(line: string, state: LexState): { tokens: Token[]; state: LexState } {
  const out = new Tokens();
  let i = 0;
  let mode = state.mode;
  if (mode === "blockComment") {
    const end = line.indexOf("*/");
    if (end === -1) return { tokens: [{ text: line, kind: "comment" }], state };
    out.push(line.slice(0, end + 2), "comment");
    i = end + 2;
    mode = "normal";
  }
  // True right after "{" or ";" (or at line start) until something other than whitespace.
  let declarationStart = true;
  while (i < line.length) {
    const rest = line.slice(i, i + 256);
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        out.push(line.slice(i), "comment");
        mode = "blockComment";
        break;
      }
      out.push(line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = closeQuote(line, i + 1, ch);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop), "string");
      i = stop;
      declarationStart = false;
      continue;
    }
    if (ch === "{" || ch === ";") {
      out.push(ch, "punctuation");
      i++;
      declarationStart = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      out.push(ch, "plain");
      i++;
      continue;
    }
    const wasDeclarationStart = declarationStart;
    declarationStart = false;
    const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(rest);
    if (hex && /[\s:,(]/.test(i > 0 ? line[i - 1] : " ")) {
      out.push(hex[0], "number");
      i += hex[0].length;
      continue;
    }
    const prev = i > 0 ? line[i - 1] : " ";
    const number = /[\w-]/.test(prev) ? null : /^-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?/.exec(rest);
    if (number) {
      out.push(number[0], "number");
      i += number[0].length;
      continue;
    }
    const at = /^@[\w-]+/.exec(rest);
    if (at) {
      out.push(at[0], "keyword");
      i += at[0].length;
      continue;
    }
    const ident = /^-?[A-Za-z_][\w-]*/.exec(rest);
    if (ident) {
      const after = line.slice(i + ident[0].length, i + ident[0].length + 8);
      // "name:" at the start of a declaration (or "name: value") is a property; "a:hover" is not.
      const kind: TokenKind = (wasDeclarationStart && /^\s*:(?!:)/.test(after)) || /^\s*:\s/.test(after)
        ? "property"
        : prev === "." || prev === "#"
          ? "type"
          : /^\s*\(/.test(after)
            ? "function"
            : "plain";
      out.push(ident[0], ident[0] === "important" && prev === "!" ? "keyword" : kind);
      i += ident[0].length;
      continue;
    }
    out.push(ch, /[{}();:,.#>+~*!]/.test(ch) ? "punctuation" : "plain");
    i++;
  }
  return { tokens: out.list, state: { mode } };
}

function tokenizeHtml(line: string, state: LexState): { tokens: Token[]; state: LexState } {
  const out = new Tokens();
  let i = 0;
  let mode = state.mode;
  if (mode === "htmlComment") {
    const end = line.indexOf("-->");
    if (end === -1) return { tokens: [{ text: line, kind: "comment" }], state };
    out.push(line.slice(0, end + 3), "comment");
    i = end + 3;
    mode = "normal";
  }
  let inTag = false;
  while (i < line.length) {
    const rest = line.slice(i, i + 256); // bounded: patterns only look a short way ahead
    const ch = line[i];
    if (!inTag && rest.startsWith("<!--")) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        out.push(line.slice(i), "comment");
        mode = "htmlComment";
        break;
      }
      out.push(line.slice(i, end + 3), "comment");
      i = end + 3;
      continue;
    }
    if (!inTag) {
      const open = /^<\/?(!?[A-Za-z][\w-]*)/.exec(rest);
      if (open) {
        const bracket = open[0].slice(0, open[0].length - open[1].length);
        out.push(bracket, "punctuation");
        out.push(open[1], "tag");
        i += open[0].length;
        inTag = true;
        continue;
      }
      out.push(ch, "plain");
      i++;
      continue;
    }
    if (rest.startsWith("/>") || ch === ">") {
      const text = rest.startsWith("/>") ? "/>" : ">";
      out.push(text, "punctuation");
      i += text.length;
      inTag = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = closeQuote(line, i + 1, ch);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop), "string");
      i = stop;
      continue;
    }
    const attr = /^[A-Za-z_:@][\w:.-]*/.exec(rest);
    if (attr) {
      out.push(attr[0], "attr");
      i += attr[0].length;
      continue;
    }
    out.push(ch, ch === "=" ? "punctuation" : "plain");
    i++;
  }
  return { tokens: out.list, state: { mode } };
}

function tokenizeMarkdown(line: string): Token[] {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, kind: "keyword" }];
  if (/^\s*```/.test(line)) return [{ text: line, kind: "string" }];
  const out = new Tokens();
  let i = 0;
  const list = /^(\s*)([-*+]|\d+\.)(\s)/.exec(line);
  if (list) {
    out.push(list[1], "plain");
    out.push(list[2], "punctuation");
    out.push(list[3], "plain");
    i = list[0].length;
  }
  while (i < line.length) {
    const rest = line.slice(i, i + 256); // bounded: patterns only look a short way ahead
    const code = /^`[^`]*`/.exec(rest);
    if (code) {
      out.push(code[0], "string");
      i += code[0].length;
      continue;
    }
    const bold = /^\*\*[^*]+\*\*/.exec(rest);
    if (bold) {
      out.push(bold[0], "type");
      i += bold[0].length;
      continue;
    }
    const link = /^\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
    if (link) {
      out.push(`[${link[1]}]`, "function");
      out.push(`(${link[2]})`, "string");
      i += link[0].length;
      continue;
    }
    out.push(line[i], "plain");
    i++;
  }
  return out.list;
}

function tokenizeShell(line: string): Token[] {
  const out = new Tokens();
  let i = 0;
  let commandNext = true;
  while (i < line.length) {
    const rest = line.slice(i, i + 256); // bounded: patterns only look a short way ahead
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : " ";
    if (ch === "#" && /\s/.test(prev)) {
      out.push(line.slice(i), "comment");
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = closeQuote(line, i + 1, ch);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop), "string");
      i = stop;
      commandNext = false;
      continue;
    }
    const variable = /^\$(?:\{[^}]*\}|[A-Za-z_]\w*|\d|[@?$#*])/.exec(rest);
    if (variable) {
      out.push(variable[0], "type");
      i += variable[0].length;
      continue;
    }
    if (/^(\|\||&&|[|;&])/.test(rest)) {
      const op = /^(\|\||&&|[|;&])/.exec(rest)![0];
      out.push(op, "punctuation");
      i += op.length;
      commandNext = true;
      continue;
    }
    const flag = /\s/.test(prev) ? /^--?[\w-]+/.exec(rest) : null;
    if (flag) {
      out.push(flag[0], "attr");
      i += flag[0].length;
      continue;
    }
    const word = /^[\w./~-]+/.exec(rest);
    if (word) {
      const text = word[0];
      let kind: TokenKind = "plain";
      if (SHELL_KEYWORDS.has(text)) kind = "keyword";
      else if (commandNext) kind = "function";
      else if (/^\d+$/.test(text)) kind = "number";
      out.push(text, kind);
      i += text.length;
      if (!SHELL_KEYWORDS.has(text)) commandNext = false;
      continue;
    }
    out.push(ch, "plain");
    i++;
  }
  return out.list;
}

export function tokenizeLine(line: string, lang: Lang, state: LexState): { tokens: Token[]; state: LexState } {
  switch (lang) {
    case "js":
      return tokenizeJs(line, state);
    case "css":
      return tokenizeCss(line, state);
    case "html":
      return tokenizeHtml(line, state);
    case "json":
      return { tokens: tokenizeJson(line), state: START };
    case "markdown":
      return { tokens: tokenizeMarkdown(line), state: START };
    case "shell":
      return { tokens: tokenizeShell(line), state: START };
  }
}

/** Only the multi-line mode at the end of a line, without building tokens (fast scan). */
function scanMode(line: string, lang: Lang, mode: LexState["mode"]): LexState["mode"] {
  if (lang === "html") {
    let at = 0;
    for (;;) {
      if (mode === "htmlComment") {
        const end = line.indexOf("-->", at);
        if (end === -1) return mode;
        at = end + 3;
        mode = "normal";
      } else {
        const start = line.indexOf("<!--", at);
        if (start === -1) return mode;
        at = start + 4;
        mode = "htmlComment";
      }
    }
  }
  if (lang !== "js" && lang !== "css") return "normal";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (mode === "blockComment") {
      if (ch === "*" && line[i + 1] === "/") {
        mode = "normal";
        i++;
      }
      continue;
    }
    if (mode === "template") {
      if (ch === "\\") i++;
      else if (ch === "`") mode = "normal";
      continue;
    }
    if (ch === "/" && line[i + 1] === "/" && lang === "js") return mode;
    if (ch === "/" && line[i + 1] === "*") {
      mode = "blockComment";
      i++;
    } else if (ch === "'" || ch === '"') {
      const end = closeQuote(line, i + 1, ch);
      if (end === -1) return mode;
      i = end - 1;
    } else if (ch === "`" && lang === "js") {
      mode = "template";
    }
  }
  return mode;
}

/** The state entering the line after `line`, found with the fast scan (no tokens built). */
export function stateAfterLine(line: string, lang: Lang, state: LexState): LexState {
  const mode = scanMode(line, lang, state.mode);
  return mode === "normal" ? START : { mode };
}

/** The lexer state entering `lines[lineIndex]`. */
export function stateAt(lines: string[], lang: Lang, lineIndex: number): LexState {
  let mode: LexState["mode"] = "normal";
  for (let i = 0; i < lineIndex && i < lines.length; i++) mode = scanMode(lines[i], lang, mode);
  return mode === "normal" ? START : { mode };
}
