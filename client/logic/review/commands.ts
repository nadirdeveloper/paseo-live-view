/** Recognises the shell commands a PR review is made of. Pure; no I/O. */

export type ReadRange = { from: number; to: number | null } | { tail: number };

export type ReviewCommand =
  | { kind: "pr-diff"; pr: string | null; redirect: string | null }
  | { kind: "pr-view"; pr: string | null }
  | { kind: "file-at-head"; repo: string; path: string; ref: string | null }
  | { kind: "read-linked"; path: string; range: ReadRange };

export type Persisted = { savedPath: string; preview: string };

/** Split into shell words, honouring single and double quotes. Operators stay separate words. */
function words(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
      continue;
    }
    if (ch === ">" || ch === "|") {
      if (has || current) out.push(current);
      current = "";
      has = false;
      if (ch === ">" && segment[i + 1] === ">") i++;
      out.push(ch);
      continue;
    }
    current += ch;
    has = true;
  }
  if (has || current) out.push(current);
  return out;
}

/** Split on `&&`, `||` and `;` outside quotes. */
function statements(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Split a statement's words into pipeline stages. */
function stages(ws: string[]): string[][] {
  const out: string[][] = [[]];
  for (const w of ws) {
    if (w === "|") out.push([]);
    else out[out.length - 1].push(w);
  }
  return out;
}

const VALUE_FLAGS = new Set(["-R", "--repo", "--color"]);

function prArgument(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

function redirectTarget(stage: string[]): { args: string[]; target: string | null } {
  const at = stage.indexOf(">");
  if (at === -1) return { args: stage, target: null };
  return { args: stage.slice(0, at), target: stage[at + 1] ?? null };
}

function detectPrDiff(ws: string[]): ReviewCommand | null {
  const parts = stages(ws);
  const first = parts[0];
  if (first[0] !== "gh" || first[1] !== "pr" || first[2] !== "diff") return null;
  const { args, target } = redirectTarget(first.slice(3));
  if (args.includes("--name-only") || args.includes("--stat")) return null;
  let redirect = target;
  for (const stage of parts.slice(1)) {
    // Only `tee <file>` keeps the output a diff; anything else (grep, head…) changes it.
    if (stage[0] !== "tee") return null;
    const file = stage.slice(1).find((a) => !a.startsWith("-"));
    if (file) redirect = file;
  }
  return { kind: "pr-diff", pr: prArgument(args), redirect };
}

function detectPrView(ws: string[]): ReviewCommand | null {
  if (ws[0] !== "gh" || ws[1] !== "pr" || ws[2] !== "view") return null;
  const json = ws.indexOf("--json");
  if (json === -1 || !(ws[json + 1] ?? "").split(",").includes("files")) return null;
  const args = ws.slice(3).filter((_, i, all) => !(all[i - 1] === "--json" || all[i - 1] === "--jq" || all[i - 1] === "-q"));
  return { kind: "pr-view", pr: prArgument(args.filter((a) => a !== "--json")) };
}

function detectFileAtHead(statement: string): ReviewCommand | null {
  if (!/\bgh\s+api\b/.test(statement) || !/base64\s+(-d|--decode|-D)\b/.test(statement)) return null;
  const match = /repos\/([^/\s"']+\/[^/\s"']+)\/contents\/([^"'?\s]+)(?:\?ref=([^"'\s&]+))?/.exec(statement);
  if (!match) return null;
  return { kind: "file-at-head", repo: match[1], path: decodeURIComponent(match[2]), ref: match[3] ?? null };
}

function detectRead(ws: string[]): ReviewCommand | null {
  if (ws.includes("|") || ws.includes(">")) return null;
  const [cmd, ...rest] = ws;
  const paths = rest.filter((a) => !a.startsWith("-"));
  if (cmd === "cat") {
    return paths.length === 1 && rest.length === 1 ? { kind: "read-linked", path: paths[0], range: { from: 1, to: null } } : null;
  }
  if (cmd === "head" || cmd === "tail") {
    let count = 10;
    let path: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "-n") count = Number(rest[++i]);
      else if (/^-n?\d+$/.test(a)) count = Number(a.replace(/^-n?/, ""));
      else if (!a.startsWith("-")) {
        if (path) return null;
        path = a;
      }
    }
    if (!path || !Number.isFinite(count)) return null;
    return { kind: "read-linked", path, range: cmd === "head" ? { from: 1, to: count } : { tail: count } };
  }
  if (cmd === "sed" && rest[0] === "-n" && rest.length === 3) {
    const range = /^(\d+),(\d+)p$/.exec(rest[1]);
    if (!range) return null;
    return { kind: "read-linked", path: rest[2], range: { from: Number(range[1]), to: Number(range[2]) } };
  }
  return null;
}

export function detectReviewCommand(command: string): ReviewCommand | null {
  for (const statement of statements(command)) {
    const ws = words(statement);
    const found = detectPrDiff(ws) ?? detectPrView(ws) ?? detectFileAtHead(statement);
    if (found) return found;
  }
  // A plain read is only meaningful as the whole (last) statement, e.g. `cd x && sed -n '1,9p' f`.
  const all = statements(command);
  return all.length > 0 ? detectRead(words(all[all.length - 1])) : null;
}

const PERSISTED = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: (.+)\n\nPreview \(first [^)]*\):\n([\s\S]*?)(?:\n\.\.\.)?\n<\/persisted-output>\s*$/;

/** Claude Code's notice for output it saved to a file instead of showing in full. */
export function parsePersisted(output: string): Persisted | null {
  const match = PERSISTED.exec(output);
  return match ? { savedPath: match[1].trim(), preview: match[2] } : null;
}
