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
  mode: "code" | "review";
  /** The user picked a mode with the switch; automatic switching waits for the next review. */
  manual: boolean;
  activeId: string | null;
};

export type ReviewEffect =
  | { kind: "read-diff"; reviewId: string; from: number; to: number }
  | { kind: "read-file"; reviewId: string; path: string }
  | { kind: "switch"; mode: "code" | "review" };

export const emptyReview: ReviewState = { reviews: [], links: new Map(), mode: "code", manual: false, activeId: null };

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
    const body = persisted ? persisted.preview : command.redirect ? "" : output;
    if (body) next = addLines(next, review.id, 1, body, !persisted, effects);
    return next;
  }

  if (command.kind === "pr-view") {
    try {
      const parsed = JSON.parse(output) as { files?: { path: string; additions: number; deletions: number }[] };
      if (!Array.isArray(parsed.files)) return s;
      const { state, review } = withReview(s, idFor(command.pr), labelFor(command.pr));
      const allFiles = parsed.files.map((f) => ({ path: f.path, adds: f.additions, dels: f.deletions }));
      return replace(state, { ...review, allFiles });
    } catch {
      return s;
    }
  }

  if (command.kind === "file-at-head") {
    const target = newestReview(s);
    const { state, review } = target ? { state: s, review: target } : withReview(s, "PR", "PR");
    const headFiles = new Map(review.headFiles);
    headFiles.set(command.path, output);
    effects.push({ kind: "read-file", reviewId: review.id, path: command.path });
    return switchTo(replace(state, { ...review, headFiles }), "review", effects);
  }

  // read-linked: only counts when the path is a diff we know about.
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
  const reviewId = linkedReview(s, ev.filePath);
  if (!reviewId) return s;
  const lineCount = ev.content.split("\n").length;
  const whole = (ev.offset === null || ev.offset === 1) && ev.limit === null && lineCount < READ_TOOL_DEFAULT_LINES;
  return addLines(s, reviewId, ev.offset ?? 1, ev.content, whole, effects);
}

export function applyToReview(s: ReviewState, ev: LiveEvent): { state: ReviewState; effects: ReviewEffect[] } {
  const effects: ReviewEffect[] = [];
  let state = s;
  if (ev.kind === "shell") state = onShell(s, ev, effects);
  else if (ev.kind === "read") state = onRead(s, ev, effects);
  else if (ev.kind === "thought" && ev.source === "message") {
    const report = parseReport(ev.text);
    if (report && s.reviews.length > 0) {
      const target = s.reviews.find((r) => report.prs.includes(r.label)) ?? newestReview(s)!;
      state = replace(s, { ...target, report });
    }
  } else if ((ev.kind === "edit" || ev.kind === "write") && ev.inWorkspace && ev.status === "completed") {
    state = switchTo(s, "code", effects);
  }
  return { state, effects };
}

export function setMode(s: ReviewState, mode: "code" | "review"): ReviewState {
  return { ...s, mode, manual: true };
}
