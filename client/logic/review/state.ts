import type { LiveEvent, ReadEvent, ShellEvent } from "../events";
import { detectReviewCommand, parsePersisted } from "./commands";
import type { DiffFile } from "./diff";
import { parseReport, type Report } from "./findings";
import { addSegment, addTail, emptyDoc, filesOf, type FileCoverage, type SparseDoc } from "./sparse";

export type Review = {
  id: string;
  label: string;
  doc: SparseDoc;
  files: DiffFile[];
  coverage: FileCoverage[];
  allFiles: { path: string; adds: number; dels: number }[] | null;
  headFiles: Map<string, string>;
  report: Report | null;
};

export type ReviewState = {
  reviews: Review[];
  /** Diff files on disk (saved output, redirects) → review id. */
  links: Map<string, string>;
  /** Saved outputs of whole-file fetches → the review and file they belong to. */
  headLinks: Map<string, { reviewId: string; path: string }>;
  /** Saved outputs of `gh pr view --json files` → review id. */
  viewLinks: Map<string, string>;
  /** Each agent's current message so far (messages stream in pieces). */
  buffers: Map<string, string>;
  mode: "code" | "review";
  /** The user picked a mode with the switch; automatic switching waits for the next review. */
  manual: boolean;
  activeId: string | null;
};

export type ReviewEffect =
  | { kind: "read-diff"; reviewId: string; from: number; to: number }
  | { kind: "read-file"; reviewId: string; path: string }
  | { kind: "switch"; mode: "code" | "review" };

export const emptyReview: ReviewState = {
  reviews: [],
  links: new Map(),
  headLinks: new Map(),
  viewLinks: new Map(),
  buffers: new Map(),
  mode: "code",
  manual: false,
  activeId: null,
};

/** A full copy replaces what we have; a piece is appended. */
function combine(current: string, incoming: string): string {
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return current + incoming;
}

function splice(text: string, from: number, incoming: string, whole: boolean): string {
  if (whole) return incoming;
  const lines = text === "" ? [] : text.split("\n");
  const add = incoming.split("\n");
  if (add.length > 1 && add[add.length - 1] === "") add.pop();
  add.forEach((line, i) => {
    lines[from - 1 + i] = line;
  });
  return Array.from(lines, (l) => l ?? "").join("\n");
}

function parseFiles(output: string): Review["allFiles"] {
  try {
    const parsed = JSON.parse(output) as { files?: { path: string; additions: number; deletions: number }[] };
    return Array.isArray(parsed.files) ? parsed.files.map((f) => ({ path: f.path, adds: f.additions, dels: f.deletions })) : null;
  } catch {
    return null;
  }
}

/** A read of a saved head file or saved file list. Returns null when the path is neither. */
function savedRead(s: ReviewState, path: string, from: number, text: string, whole: boolean): ReviewState | null {
  const head = s.headLinks.get(path);
  if (head) {
    const review = s.reviews.find((r) => r.id === head.reviewId);
    if (!review) return s;
    const headFiles = new Map(review.headFiles);
    headFiles.set(head.path, splice(headFiles.get(head.path) ?? "", from, text, whole));
    return replace(s, { ...review, headFiles });
  }
  const viewId = s.viewLinks.get(path);
  if (viewId) {
    const review = s.reviews.find((r) => r.id === viewId);
    const allFiles = review ? parseFiles(text) : null;
    return review && allFiles ? replace(s, { ...review, allFiles }) : s;
  }
  return null;
}

/** The Read tool returns at most this many lines when no limit is given. */
const READ_TOOL_DEFAULT_LINES = 2000;

function labelFor(pr: string | null): string {
  if (!pr) return "PR";
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  if (url) return `${url[1]}#${url[2]}`;
  return /^\d+$/.test(pr) ? `#${pr}` : pr;
}

function idFor(pr: string | null): string {
  return labelFor(pr);
}

function withReview(s: ReviewState, id: string, label: string): { state: ReviewState; review: Review; isNew: boolean } {
  const existing = s.reviews.find((r) => r.id === id);
  if (existing) return { state: s, review: existing, isNew: false };
  const review: Review = { id, label, doc: emptyDoc, files: [], coverage: [], allFiles: null, headFiles: new Map(), report: null };
  return { state: { ...s, reviews: [...s.reviews, review] }, review, isNew: true };
}

function replace(s: ReviewState, review: Review): ReviewState {
  return { ...s, reviews: s.reviews.map((r) => (r.id === review.id ? review : r)), activeId: review.id };
}

function withDoc(review: Review, doc: SparseDoc): Review {
  if (doc === review.doc) return review;
  const { files, coverage } = filesOf(doc);
  return { ...review, doc, files, coverage };
}

function switchTo(s: ReviewState, mode: "code" | "review", effects: ReviewEffect[]): ReviewState {
  if (s.manual || s.mode === mode) return s;
  effects.push({ kind: "switch", mode });
  return { ...s, mode };
}

function linkedReview(s: ReviewState, path: string): string | null {
  for (const [linked, id] of s.links) {
    if (linked === path || path.endsWith("/" + linked.replace(/^\.\//, ""))) return id;
  }
  return null;
}

function newestReview(s: ReviewState): Review | null {
  return s.reviews.find((r) => r.id === s.activeId) ?? s.reviews[s.reviews.length - 1] ?? null;
}

function addLines(s: ReviewState, reviewId: string, from: number, text: string, whole: boolean, effects: ReviewEffect[]): ReviewState {
  const review = s.reviews.find((r) => r.id === reviewId);
  if (!review) return s;
  const { doc, added } = addSegment(review.doc, from, text, { isWholeFile: whole });
  let next = replace(s, withDoc(review, doc));
  if (added) {
    effects.push({ kind: "read-diff", reviewId, ...added });
    next = switchTo(next, "review", effects);
  }
  return next;
}

function onShell(s: ReviewState, ev: ShellEvent, effects: ReviewEffect[]): ReviewState {
  if (ev.status !== "completed") return s;
  const command = detectReviewCommand(ev.command);
  if (!command) return s;
  const output = ev.rawOutput ?? ev.output ?? "";

  if (command.kind === "pr-diff") {
    const { state, review, isNew } = withReview(s, idFor(command.pr), labelFor(command.pr));
    let next = isNew ? { ...state, manual: false } : state;
    const links = new Map(next.links);
    if (command.redirect) links.set(command.redirect, review.id);
    const persisted = parsePersisted(output);
    if (persisted) links.set(persisted.savedPath, review.id);
    next = { ...next, links, activeId: review.id };
    if (isNew) next = switchTo(next, "review", effects);
    if (persisted) return addLines(next, review.id, 1, persisted.preview, false, effects);
    if (command.shown && output) return addLines(next, review.id, 1, output, true, effects);
    // `gh pr diff > f && head -n 300 f`: what the agent saw is that read of f.
    const after = command.readAfter;
    if (after && output && !("tail" in after)) return addLines(next, review.id, after.from, output, after.from === 1 && after.to === null, effects);
    return next;
  }

  if (command.kind === "pr-view") {
    const persisted = parsePersisted(output);
    const { state, review } = withReview(s, idFor(command.pr), labelFor(command.pr));
    if (persisted) {
      const viewLinks = new Map(state.viewLinks);
      viewLinks.set(persisted.savedPath, review.id);
      return { ...state, viewLinks };
    }
    const allFiles = parseFiles(output);
    return allFiles ? replace(state, { ...review, allFiles }) : s;
  }

  if (command.kind === "file-at-head") {
    const target = newestReview(s);
    const { state, review } = target ? { state: s, review: target } : withReview(s, "PR", "PR");
    const persisted = parsePersisted(output);
    const headFiles = new Map(review.headFiles);
    headFiles.set(command.path, persisted ? persisted.preview : output);
    let next = replace(state, { ...review, headFiles });
    if (persisted) {
      const headLinks = new Map(next.headLinks);
      headLinks.set(persisted.savedPath, { reviewId: review.id, path: command.path });
      next = { ...next, headLinks };
    }
    effects.push({ kind: "read-file", reviewId: review.id, path: command.path });
    return switchTo(next, "review", effects);
  }

  // read-linked: a saved head file / file list, or a diff we know about.
  if (!("tail" in command.range)) {
    const saved = savedRead(s, command.path, command.range.from, output, command.range.from === 1 && command.range.to === null);
    if (saved) return saved;
  }
  const reviewId = linkedReview(s, command.path);
  if (!reviewId) return s;
  const range = command.range;
  if ("tail" in range) {
    const review = s.reviews.find((r) => r.id === reviewId)!;
    const { doc, added } = addTail(review.doc, range.tail, output);
    let next = replace(s, withDoc(review, doc));
    if (added) {
      effects.push({ kind: "read-diff", reviewId, ...added });
      next = switchTo(next, "review", effects);
    }
    return next;
  }
  return addLines(s, reviewId, range.from, output, range.from === 1 && range.to === null, effects);
}

function onRead(s: ReviewState, ev: ReadEvent, effects: ReviewEffect[]): ReviewState {
  if (ev.status !== "completed") return s;
  const lineCount = ev.content.split("\n").length;
  const whole = (ev.offset === null || ev.offset === 1) && ev.limit === null && lineCount < READ_TOOL_DEFAULT_LINES;
  const saved = savedRead(s, ev.filePath, ev.offset ?? 1, ev.content, whole);
  if (saved) return saved;
  const reviewId = linkedReview(s, ev.filePath);
  if (!reviewId) return s;
  return addLines(s, reviewId, ev.offset ?? 1, ev.content, whole, effects);
}

export function applyToReview(s: ReviewState, ev: LiveEvent): { state: ReviewState; effects: ReviewEffect[] } {
  const effects: ReviewEffect[] = [];
  let state = s;
  if (ev.kind === "thought") {
    if (ev.source !== "message") return { state, effects };
    // Messages stream in pieces: parse the message so far, not just this piece.
    const text = combine(s.buffers.get(ev.agentId) ?? "", ev.text);
    const buffers = new Map(s.buffers);
    buffers.set(ev.agentId, text);
    state = { ...s, buffers };
    const report = text.includes("### Code findings") ? parseReport(text) : null;
    if (report && state.reviews.length > 0) {
      const target = state.reviews.find((r) => report.prs.includes(r.label)) ?? newestReview(state)!;
      state = replace(state, { ...target, report });
    }
    return { state, effects };
  }
  // Anything else from this agent ends its current message.
  if (s.buffers.has(ev.agentId)) {
    const buffers = new Map(s.buffers);
    buffers.delete(ev.agentId);
    state = s = { ...s, buffers };
  }
  if (ev.kind === "shell") state = onShell(s, ev, effects);
  else if (ev.kind === "read") state = onRead(s, ev, effects);
  else if ((ev.kind === "edit" || ev.kind === "write") && ev.inWorkspace && ev.status === "completed") {
    state = switchTo(s, "code", effects);
  }
  return { state, effects };
}

export function setMode(s: ReviewState, mode: "code" | "review"): ReviewState {
  return { ...s, mode, manual: true };
}
