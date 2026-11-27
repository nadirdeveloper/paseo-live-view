import { absolutePath, type LiveEvent } from "./events";

/** Which lines of a file were read. `match` = printed lines to find by content (no line numbers given). */
export type LineSpec = { from: number; to: number | "end" } | { last: number } | { lines: number[] } | { match: string[] };
export type ReadTarget = { path: string; specs: LineSpec[] };

export const MAX_READ_FILES = 3;
export const MAX_GLANCE = 20;
export const MAX_RANGES = 8;
const MAX_MATCHES = 50;
const WHOLE: LineSpec = { from: 1, to: "end" };

// ---------- shell parsing ----------

type Token = { t: "word"; v: string } | { t: "op"; v: string } | { t: "redir" };

/**
 * Split a shell command into words, operators (| || && ; &) and redirections, honouring quotes and
 * backslashes. Heredoc bodies are skipped, so a python script's text is never taken for commands.
 */
export function tokenize(command: string): Token[] {
  const out: Token[] = [];
  let word: string | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let expectDelim: boolean | null = null; // set to the "strip tabs" flag right after `<<` / `<<-`
  const push = () => {
    if (word === null) return;
    if (expectDelim !== null) {
      heredocs.push({ delim: word, strip: expectDelim });
      expectDelim = null;
    } else out.push({ t: "word", v: word });
    word = null;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "\n") {
      push();
      out.push({ t: "op", v: ";" });
      i++;
      // Skip heredoc bodies that start after this line.
      for (const doc of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i++;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? "") + command.slice(i + 1, end === -1 ? command.length : end);
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        text += command[j++];
      }
      word = (word ?? "") + text;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") i += 2;
      else {
        word = (word ?? "") + (command[i + 1] ?? "");
        i += 2;
      }
      continue;
    }
    if (c === ">" || c === "<") {
      // A file descriptor number right before (2>&1) belongs to the redirection.
      if (word !== null && /^\d+$/.test(word)) word = null;
      push();
      if (c === "<" && command[i + 1] === "<") {
        const strip = command[i + 2] === "-";
        i += strip ? 3 : 2;
        if (command[i] === "<") {
          // Here-string (<<<): the next word is data, not a file.
          i++;
          out.push({ t: "redir" });
          continue;
        }
        expectDelim = strip;
        continue;
      }
      i += command[i + 1] === ">" || command[i + 1] === "&" ? 2 : 1;
      out.push({ t: "redir" });
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      push();
      const two = command.slice(i, i + 2);
      if (two === "&>") {
        i += 2;
        out.push({ t: "redir" });
        continue;
      }
      if (two === "||" || two === "&&") {
        out.push({ t: "op", v: two });
        i += 2;
      } else {
        out.push({ t: "op", v: c });
        i++;
      }
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  push();
  return out;
}

type Segment = { words: string[]; piped: boolean };

function segments(tokens: Token[]): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let skipNext = false;
  for (const tok of tokens) {
    if (tok.t === "redir") {
      skipNext = true;
      continue;
    }
    if (tok.t === "word") {
      if (skipNext) skipNext = false;
      else words.push(tok.v);
      continue;
    }
    skipNext = false;
    out.push({ words, piped: tok.v === "|" });
    words = [];
  }
  out.push({ words, piped: false });
  return out.filter((s) => s.words.length > 0);
}

const PREFIXES = new Set(["sudo", "command", "exec", "time", "nice", "nohup"]);

function program(words: string[]): { name: string; args: string[] } | null {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i]))) i++;
  if (i >= words.length) return null;
  const name = words[i].split("/").pop() ?? words[i];
  return { name, args: words.slice(i + 1) };
}

/** Plain operands (no flags); "-" (stdin) and "--" are dropped. */
function operands(args: string[], withValue: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let onlyOperands = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (onlyOperands) out.push(a);
    else if (a === "--") onlyOperands = true;
    else if (a === "-") continue;
    else if (a.startsWith("-")) {
      if (withValue.has(a)) i++;
    } else out.push(a);
  }
  return out;
}

function countFlag(args: string[], flag: string, long?: string): number | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) return Number(args[i + 1]);
    if (a.startsWith(flag) && /^-n\d+$|^-c\d+$/.test(a)) return Number(a.slice(2));
    if (long && a.startsWith(`${long}=`)) return Number(a.slice(long.length + 1));
    if (/^-\d+$/.test(a)) return Number(a.slice(1));
  }
  return null;
}

function headTail(name: "head" | "tail", args: string[]): ReadTarget[] | null {
  const files = operands(args, new Set(["-n", "-c"]));
  let spec: LineSpec;
  const plus = args.findIndex((a, i) => args[i - 1] === "-n" && /^\+\d+$/.test(a));
  if (name === "tail" && plus !== -1) spec = { from: Number(args[plus].slice(1)), to: "end" };
  else {
    const n = countFlag(args, "-n", "--lines");
    const count = n !== null && Number.isFinite(n) && n > 0 ? n : 10;
    spec = name === "head" ? { from: 1, to: count } : { last: count };
  }
  return files.map((path) => ({ path, specs: [spec] }));
}

function sedRanges(script: string): LineSpec[] {
  const specs: LineSpec[] = [];
  for (const part of script.split(/[;\n]/)) {
    const m = /^\s*(\d+)(?:,(\d+|\$|\+\d+))?\s*p\s*$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === "$" ? "end" : m[2].startsWith("+") ? from + Number(m[2].slice(1)) : Number(m[2]);
    specs.push({ from, to });
  }
  return specs;
}

function sed(args: string[]): ReadTarget[] | null {
  if (args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place="))) return null;
  if (!args.some((a) => a === "-n" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")) || a === "--quiet" || a === "--silent")) return null;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e" || a === "--expression") scripts.push(args[++i] ?? "");
    else if (a === "-f") return null;
    else if (!a.startsWith("-")) rest.push(a);
  }
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!);
  const specs = scripts.flatMap(sedRanges);
  if (specs.length === 0) return null;
  return rest.map((path) => ({ path, specs }));
}

function awk(args: string[]): ReadTarget[] | null {
  const ops = operands(args, new Set(["-F", "-v", "-f"]));
  const [prog, ...files] = ops;
  if (!prog) return null;
  const between = /NR\s*(>=|>)\s*(\d+)\s*&&\s*NR\s*(<=|<)\s*(\d+)/.exec(prog);
  const exact = /NR\s*==\s*(\d+)/.exec(prog);
  const after = /^\s*NR\s*(>=|>)\s*(\d+)\s*(\{|$)/.exec(prog);
  let spec: LineSpec | null = null;
  if (between) {
    const from = Number(between[2]) + (between[1] === ">" ? 1 : 0);
    const to = Number(between[4]) - (between[3] === "<" ? 1 : 0);
    spec = { from, to };
  } else if (exact) spec = { from: Number(exact[1]), to: Number(exact[1]) };
  else if (after) spec = { from: Number(after[2]) + (after[1] === ">" ? 1 : 0), to: "end" };
  if (!spec) return null;
  return files.map((path) => ({ path, specs: [spec!] }));
}

function bat(args: string[]): ReadTarget[] {
  const files = operands(args, new Set(["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--theme", "--style", "-m", "--map-syntax"]));
  const range = args.findIndex((a) => a === "-r" || a === "--line-range");
  const m = range !== -1 ? /^(\d+)?:(\d+)?$/.exec(args[range + 1] ?? "") : null;
  const spec: LineSpec = m ? { from: m[1] ? Number(m[1]) : 1, to: m[2] ? Number(m[2]) : "end" } : WHOLE;
  return files.map((path) => ({ path, specs: [spec] }));
}

const GREP_VALUE = new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--include", "--exclude", "--exclude-dir", "--regexp", "--file", "--max-count", "--context"]);
const RG_VALUE = new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-M", "-r", "-E", "--type", "--type-not", "--glob", "--iglob", "--regexp", "--file", "--max-count", "--replace", "--encoding", "--context", "--max-columns"]);

type GrepResult = { reads: ReadTarget[]; glance: string[] };

/** Hits printed as `path:N:text` (or `path:text` without line numbers), grouped by file. */
export function parseMultiFileHits(output: string): Map<string, LineSpec> {
  const byPath = new Map<string, { lines: number[]; match: string[] }>();
  for (const line of output.split("\n")) {
    if (!line || line === "--") continue;
    const numbered = /^(.+?):(\d+):(.*)$/.exec(line);
    const plain = numbered ? null : /^([^:]+):(.*)$/.exec(line);
    const path = numbered?.[1] ?? plain?.[1];
    if (!path) continue;
    const entry = byPath.get(path) ?? { lines: [], match: [] };
    if (numbered) entry.lines.push(Number(numbered[2]));
    else entry.match.push(plain![2]);
    byPath.set(path, entry);
  }
  const out = new Map<string, LineSpec>();
  for (const [path, e] of byPath) out.set(path, e.lines.length > 0 ? { lines: e.lines } : { match: e.match.slice(0, MAX_MATCHES) });
  return out;
}

function singleFileHits(output: string): LineSpec | null {
  const lines = output.split("\n").filter((l) => l && l !== "--");
  if (lines.length === 0) return null;
  const numbered = lines.map((l) => /^(\d+)[:-]/.exec(l));
  if (numbered.every(Boolean)) return { lines: numbered.map((m) => Number(m![1])) };
  return { match: lines.slice(0, MAX_MATCHES) };
}

function grep(name: string, args: string[], output: string | undefined): GrepResult | null {
  const isRg = name === "rg";
  const values = isRg ? RG_VALUE : GREP_VALUE;
  const shortFlags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
  const has = (f: string, long: string) => shortFlags.includes(f) || args.includes(long);
  if (has("c", "--count") || has("L", "--files-without-match")) return null;
  const ops = operands(args, values);
  const usesE = args.includes("-e") || args.includes("--regexp") || args.includes("-f");
  const files = usesE ? ops : ops.slice(1);
  if (files.length === 0 && !isRg) return null; // reading stdin
  const text = output ?? "";
  if (has("l", "--files-with-matches")) {
    return { reads: [], glance: text.split("\n").map((l) => l.trim()).filter(Boolean) };
  }
  const recursive = isRg || has("r", "--recursive") || has("R", "--dereference-recursive");
  const only = files.length === 1 ? files[0].replace(/\/$/, "") : null;
  const lines = text.split("\n").filter(Boolean);
  const single = only !== null && (!recursive || (isRg && !lines.every((l) => l.startsWith(`${only}/`))));
  if (single) {
    const spec = singleFileHits(text);
    return spec ? { reads: [{ path: only!, specs: [spec] }], glance: [] } : null;
  }
  const hits = parseMultiFileHits(text);
  return { reads: [...hits].map(([path, spec]) => ({ path, specs: [spec] })), glance: [] };
}

function fromShell(command: string, output: string | undefined, cwd: string): GrepResult {
  const reads: ReadTarget[] = [];
  const glance: string[] = [];
  let dir = cwd;
  for (const seg of segments(tokenize(command))) {
    const prog = program(seg.words);
    if (!prog) continue;
    const { name, args } = prog;
    if (name === "cd") {
      const target = args[0];
      if (target && !target.startsWith("~") && target !== "-") dir = absolutePath(target, dir);
      continue;
    }
    let found: ReadTarget[] | null = null;
    if (name === "cat" || name === "nl") found = operands(args, name === "nl" ? new Set(["-b", "-n", "-s", "-v", "-w", "-i"]) : undefined).map((path) => ({ path, specs: [WHOLE] }));
    else if (name === "bat" || name === "batcat") found = bat(args);
    else if (name === "head" || name === "tail") found = headTail(name, args);
    else if (name === "sed") found = sed(args);
    else if (name === "awk" || name === "gawk") found = awk(args);
    else if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") {
      // Output belongs to this command only when it isn't piped onward.
      const result = grep(name, args, seg.piped ? "" : output);
      if (result) {
        found = result.reads;
        glance.push(...result.glance.map((p) => absolutePath(p, dir)));
      }
    }
    for (const t of found ?? []) reads.push({ path: absolutePath(t.path, dir), specs: t.specs });
  }
  return { reads, glance };
}

// ---------- tools ----------

function mergeTargets(targets: ReadTarget[]): ReadTarget[] {
  const byPath = new Map<string, LineSpec[]>();
  for (const t of targets) {
    if (!t.path) continue;
    const specs = byPath.get(t.path);
    if (specs) specs.push(...t.specs);
    else if (byPath.size < MAX_READ_FILES) byPath.set(t.path, [...t.specs]);
  }
  return [...byPath].map(([path, specs]) => ({ path, specs }));
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Files (and lines) an event read, and files a search only listed. Paths are absolute. */
export function readTargets(ev: LiveEvent, cwd: string): { reads: ReadTarget[]; glance: string[] } {
  switch (ev.kind) {
    case "shell": {
      const { reads, glance } = fromShell(ev.command, ev.output, cwd);
      return { reads: mergeTargets(reads), glance: [...new Set(glance)].slice(0, MAX_GLANCE) };
    }
    case "read": {
      const from = Math.max(1, ev.offset ?? 1);
      const spec: LineSpec = ev.limit ? { from, to: from + ev.limit - 1 } : ev.offset ? { from, to: "end" } : WHOLE;
      return { reads: [{ path: ev.filePath, specs: [spec] }], glance: [] };
    }
    case "search": {
      if (ev.toolName === "web_search") return { reads: [], glance: [] };
      if (ev.mode === "content" && ev.content) {
        let reads = [...parseMultiFileHits(ev.content)].map(([path, spec]) => ({ path: absolutePath(path, cwd), specs: [spec] }));
        if (reads.length === 0 && ev.filePaths.length === 1) {
          const spec = singleFileHits(ev.content);
          reads = spec ? [{ path: ev.filePaths[0], specs: [spec] }] : [];
        }
        return { reads: mergeTargets(reads), glance: [] };
      }
      if (ev.mode === "count") return { reads: [], glance: [] };
      let paths = ev.filePaths;
      if (paths.length === 0 && ev.content) paths = ev.content.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => absolutePath(l, cwd));
      return { reads: [], glance: paths.slice(0, MAX_GLANCE) };
    }
    case "other": {
      if (/read_multiple_files$/.test(ev.name) && Array.isArray(ev.input.paths)) {
        const paths = (ev.input.paths as unknown[]).map(str).filter((p): p is string => p !== null);
        return { reads: mergeTargets(paths.map((p) => ({ path: absolutePath(p, cwd), specs: [WHOLE] }))), glance: [] };
      }
      const path = str(ev.input.path) ?? str(ev.input.file_path);
      if (/read_(text_)?file$/.test(ev.name) && path) return { reads: [{ path: absolutePath(path, cwd), specs: [WHOLE] }], glance: [] };
      return { reads: [], glance: [] };
    }
    default:
      return { reads: [], glance: [] };
  }
}

// ---------- resolving to line ranges ----------

function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** 1-based ranges in the file, merged, sorted, clipped, each at most `cap` lines, at most 8 of them. */
export function resolveSpecs(specs: LineSpec[], text: string, cap = 80): { from: number; to: number }[] {
  const n = lineCount(text);
  const raw: { from: number; to: number }[] = [];
  let fileLines: string[] | null = null;
  for (const spec of specs) {
    if ("last" in spec) raw.push({ from: n - spec.last + 1, to: n });
    else if ("lines" in spec) for (const l of spec.lines) raw.push({ from: l, to: l });
    else if ("match" in spec) {
      fileLines ??= text.split("\n").map((l) => l.trimEnd());
      for (const wanted of spec.match.slice(0, MAX_MATCHES)) {
        const at = fileLines.indexOf(wanted.trimEnd());
        if (at !== -1) raw.push({ from: at + 1, to: at + 1 });
      }
    } else raw.push({ from: spec.from, to: spec.to === "end" ? n : spec.to });
  }
  const clipped = raw
    .map((r) => ({ from: Math.max(1, r.from), to: Math.min(n, r.to) }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged.slice(0, MAX_RANGES).map((r) => ({ from: r.from, to: Math.min(r.to, r.from + cap - 1) }));
}
