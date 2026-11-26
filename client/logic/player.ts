import type { LiveEvent, ShellEvent } from "./events";
import type { ReviewEffect } from "./review/state";
import { BASE_CPS, TARGET_LAG_SEC, catchUpFactor, type Speed } from "./pacing";
import { reconstructEdit } from "./reconstruct";

export type EditorFrame = {
  filePath: string;
  agentLabel: string;
  text: string;
  cursor: number | null;
  highlight: { startLine: number; endLine: number } | null;
  note: string | null;
  /** Line to keep in view when there is no cursor (e.g. reading a file top to bottom). */
  focusLine?: number | null;
};

export type TerminalEntry = {
  key: string;
  agentLabel: string;
  command: string;
  typedCommand: string;
  output: string;
  shownOutputLines: number;
  hiddenLines: number;
  status: LiveEvent["status"];
  exitCode?: number | null;
  kind: "shell" | "subagent" | "failed-edit";
};

/** A waiting event with its replay script and cost prepared once, not on every tick. */
type Queued = { event: LiveEvent; enqueuedAt: number; script: Script; chars: number; fixedMs: number };

type TextScript = {
  kind: "text";
  filePath: string;
  before: string;
  offset: number;
  oldText: string;
  newText: string;
  startLine: number;
  note: string | null;
  highlightResult: boolean;
};
type DiffScript = { kind: "diff"; filePath: string; after: string; highlight: EditorFrame["highlight"] };
export type ReadPlan = { steps: { path: string; from: number; to: number }[] };
type ReadScript = { kind: "read"; reviewId: string; mode: "diff" | "file"; steps: ReadPlan["steps"] };
type Script = TextScript | DiffScript | ReadScript | { kind: "shell" } | { kind: "instant" };

type Phase = "dwell" | "delete" | "type" | "hold" | "output" | "read" | "done";

/** `step` indexes a read script's files; other scripts stay at 0. */
type Playback = { item: Queued; script: Script; phase: Phase; progress: number; step: number };

/** Where review mode is reading: diff lines (or file lines at PR head) from..to, up to cursorAt. */
export type ReaderFrame = { reviewId: string; mode: "diff" | "file"; path: string; from: number; to: number; cursorAt: number | null };

export type PlayerState = {
  queue: Queued[];
  current: Playback | null;
  done: LiveEvent[];
  paused: boolean;
  speed: Speed;
  clock: number;
  /** Catch-up factor used by the last tick (1 = normal speed). */
  factor: number;
  editor: EditorFrame | null;
  reader: ReaderFrame | null;
  terminal: TerminalEntry[];
  touched: string[];
};

/** Calm pause before an edit: long enough for the pointer to glide to the file and click it. */
const DWELL_MS = 700;
const HOLD_MS = 500;
const BUSY_PAUSE_MS = 100;
const OUTPUT_LINES_PER_SEC = 100;
const MAX_DELETE_SEC = 1;
/** Reading pace for diffs and files in review mode, before catch-up. */
const READ_LINES_PER_SEC = 25;
/** Finished events and terminal entries kept for the panel's lifetime. */
export const MAX_DONE = 500;
/** Share of the pre-edit pause spent gliding to the file before the pointer clicks it. */
export const CLICK_AT = 2 / 3;

export function createPlayer(): PlayerState {
  return {
    queue: [],
    current: null,
    done: [],
    paused: false,
    speed: 1,
    clock: 0,
    factor: 1,
    editor: null,
    reader: null,
    terminal: [],
    touched: [],
  };
}

// ---------- helpers ----------

function keepLast<T>(items: T[]): T[] {
  return items.length > MAX_DONE ? items.slice(items.length - MAX_DONE) : items;
}

/** Drop the big file text from a finished event; outside-workspace writes keep their content to view later. */
function slim(ev: LiveEvent): LiveEvent {
  if (ev.kind === "edit") return { ...ev, afterText: undefined };
  if (ev.kind === "write") return { ...ev, afterText: undefined, content: ev.inWorkspace ? undefined : ev.content };
  if (ev.kind === "shell" && ev.rawOutput !== undefined) return { ...ev, rawOutput: undefined };
  return ev;
}

function sameFrame(a: EditorFrame | null, b: EditorFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.filePath === b.filePath &&
    a.agentLabel === b.agentLabel &&
    a.cursor === b.cursor &&
    a.note === b.note &&
    a.highlight?.startLine === b.highlight?.startLine &&
    a.highlight?.endLine === b.highlight?.endLine &&
    a.text === b.text
  );
}

function sameEntry(a: TerminalEntry, b: TerminalEntry): boolean {
  return (Object.keys(a) as (keyof TerminalEntry)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function isFailure(ev: LiveEvent): boolean {
  return ev.status === "failed" || ev.status === "canceled";
}

function filePathOf(ev: LiveEvent): string | null {
  return ev.kind === "edit" || ev.kind === "write" ? ev.filePath : null;
}

function addTouched(touched: string[], ev: LiveEvent): string[] {
  const path = filePathOf(ev);
  return path && !touched.includes(path) ? [...touched, path] : touched;
}

/** Keep the file snapshot the data hook attached when a later copy of the event lacks it. */
function merge(previous: LiveEvent, next: LiveEvent): LiveEvent {
  if ((next.kind === "edit" || next.kind === "write") && (previous.kind === "edit" || previous.kind === "write")) {
    if (next.afterText === undefined && previous.afterText !== undefined) return { ...next, afterText: previous.afterText };
  }
  return next;
}

function buildScript(ev: LiveEvent): Script {
  if (ev.kind === "shell") return { kind: "shell" };
  // Reads and thoughts never play in the editor/terminal; they're handled by review mode and the strip.
  if (ev.kind === "subagent" || ev.kind === "read" || ev.kind === "thought" || isFailure(ev)) return { kind: "instant" };
  if (ev.kind === "write") {
    const content = ev.content ?? ev.afterText ?? "";
    return {
      kind: "text",
      filePath: ev.filePath,
      before: "",
      offset: 0,
      oldText: "",
      newText: content,
      startLine: 1,
      note: null,
      highlightResult: false,
    };
  }
  const rec = reconstructEdit({
    afterText: ev.afterText,
    oldString: ev.oldString,
    newString: ev.newString,
    unifiedDiff: ev.unifiedDiff,
  });
  if (rec.mode === "diff-only") {
    const lines = rec.changedLines;
    return {
      kind: "diff",
      filePath: ev.filePath,
      after: rec.after,
      highlight: lines.length ? { startLine: Math.min(...lines), endLine: Math.max(...lines) } : null,
    };
  }
  if (rec.mode === "replay") {
    return { kind: "text", filePath: ev.filePath, ...rec, note: null, highlightResult: true };
  }
  return {
    kind: "text",
    filePath: ev.filePath,
    before: rec.oldText,
    offset: 0,
    oldText: rec.oldText,
    newText: rec.newText,
    startLine: 1,
    note:
      rec.reason === "no-snapshot"
        ? "file content unavailable"
        : rec.reason === "ambiguous"
          ? "this text appears more than once; exact spot unknown"
          : "file has changed since",
    highlightResult: true,
  };
}

function firstPhase(script: Script): Phase {
  switch (script.kind) {
    case "read":
      return "dwell";
    case "text":
      return "dwell";
    case "diff":
      return "hold";
    case "shell":
      return "type";
    case "instant":
      return "done";
  }
}

function terminalEntryFor(ev: LiveEvent, instant: boolean): TerminalEntry | null {
  if (ev.kind === "shell") {
    const output = ev.output ?? "";
    return {
      key: ev.key,
      agentLabel: ev.agentLabel,
      command: ev.command,
      typedCommand: instant ? ev.command : "",
      output: instant ? output : "",
      shownOutputLines: instant ? lineCount(output) : 0,
      hiddenLines: ev.hiddenLines,
      status: ev.status,
      exitCode: ev.exitCode,
      kind: "shell",
    };
  }
  if (ev.kind === "subagent") {
    return {
      key: ev.key,
      agentLabel: ev.agentLabel,
      command: ev.description,
      typedCommand: ev.description,
      output: ev.actions.join("\n"),
      shownOutputLines: ev.actions.length,
      hiddenLines: 0,
      status: ev.status,
      kind: "subagent",
    };
  }
  if ((ev.kind === "edit" || ev.kind === "write") && isFailure(ev)) {
    return {
      key: ev.key,
      agentLabel: ev.agentLabel,
      command: ev.filePath,
      typedCommand: ev.filePath,
      output: "",
      shownOutputLines: 0,
      hiddenLines: 0,
      status: ev.status,
      kind: "failed-edit",
    };
  }
  return null;
}

function upsertEntry(terminal: TerminalEntry[], entry: TerminalEntry): TerminalEntry[] {
  const index = terminal.findIndex((e) => e.key === entry.key);
  if (index === -1) return keepLast([...terminal, entry]);
  if (sameEntry(terminal[index], entry)) return terminal;
  const next = terminal.slice();
  next[index] = entry;
  return next;
}

function textFrame(script: TextScript, ev: LiveEvent, phase: Phase, progress: number): EditorFrame {
  const prefix = script.before.slice(0, script.offset);
  const rest = script.before.slice(script.offset + script.oldText.length);
  const frame = { filePath: script.filePath, agentLabel: ev.agentLabel, note: script.note };
  if (phase === "dwell") {
    return { ...frame, text: script.before, cursor: script.offset + script.oldText.length, highlight: null };
  }
  if (phase === "delete") {
    const kept = script.oldText.slice(0, script.oldText.length - Math.floor(progress));
    return { ...frame, text: prefix + kept + rest, cursor: script.offset + kept.length, highlight: null };
  }
  if (phase === "type") {
    const typed = script.newText.slice(0, Math.floor(progress));
    return { ...frame, text: prefix + typed + rest, cursor: script.offset + typed.length, highlight: null };
  }
  const lines = lineCount(script.newText);
  const highlight =
    script.highlightResult && lines > 0
      ? { startLine: script.startLine, endLine: script.startLine + lines - 1 }
      : null;
  return { ...frame, text: prefix + script.newText + rest, cursor: null, highlight };
}

/** Apply the playback's current look to the editor and terminal. */
function render(s: PlayerState, pb: Playback): PlayerState {
  const ev = pb.item.event;
  const { script, phase, progress } = pb;
  const withEditor = (frame: EditorFrame) => (sameFrame(s.editor, frame) ? s : { ...s, editor: frame });
  if (script.kind === "read") {
    const step = script.steps[Math.min(pb.step, script.steps.length - 1)];
    const cursorAt = phase === "read" ? Math.min(step.to, step.from + Math.floor(progress)) : phase === "done" ? step.to : null;
    const frame: ReaderFrame = { reviewId: script.reviewId, mode: script.mode, path: step.path, from: step.from, to: step.to, cursorAt };
    const same =
      s.reader &&
      s.reader.reviewId === frame.reviewId &&
      s.reader.mode === frame.mode &&
      s.reader.path === frame.path &&
      s.reader.from === frame.from &&
      s.reader.to === frame.to &&
      s.reader.cursorAt === frame.cursorAt;
    return same ? s : { ...s, reader: frame };
  }
  if (script.kind === "text") {
    // A different file only opens once the pointer has clicked it in the tree.
    if (phase === "dwell" && s.editor?.filePath !== script.filePath && dwellFraction(s, pb) < CLICK_AT) return s;
    return withEditor(textFrame(script, ev, phase, progress));
  }
  if (script.kind === "diff") {
    return withEditor({
      filePath: script.filePath,
      agentLabel: ev.agentLabel,
      text: script.after,
      cursor: null,
      highlight: script.highlight,
      note: null,
    });
  }
  if (script.kind === "shell" && ev.kind === "shell") {
    const output = ev.output ?? "";
    const entry: TerminalEntry = {
      ...terminalEntryFor(ev, false)!,
      typedCommand: phase === "type" ? ev.command.slice(0, Math.floor(progress)) : ev.command,
      output: phase === "output" || phase === "done" ? output : "",
      shownOutputLines:
        phase === "done" ? lineCount(output) : phase === "output" ? Math.min(lineCount(output), Math.floor(progress)) : 0,
    };
    const terminal = upsertEntry(s.terminal, entry);
    return terminal === s.terminal ? s : { ...s, terminal };
  }
  return s;
}

function dwellFraction(s: PlayerState, pb: Playback): number {
  const total = totalForPhase(pb, s.queue.length > 0, s.factor);
  return total > 0 ? Math.min(1, pb.progress / total) : 1;
}

function startNext(s: PlayerState): PlayerState {
  const [item, ...queue] = s.queue;
  const script = item.script;
  const pb: Playback = { item, script, phase: firstPhase(script), progress: 0, step: 0 };
  let next: PlayerState = { ...s, queue, current: pb };
  if (script.kind === "instant") {
    const entry = terminalEntryFor(item.event, true);
    if (entry) next = { ...next, terminal: upsertEntry(next.terminal, entry) };
  }
  return render(next, pb);
}

function finish(s: PlayerState): PlayerState {
  const pb = s.current!;
  if (pb.script.kind === "read") {
    return { ...s, reader: null, current: null, done: keepLast([...s.done, slim(pb.item.event)]) };
  }
  const rendered = render(s, { ...pb, phase: "done" });
  return { ...rendered, current: null, done: keepLast([...s.done, slim(pb.item.event)]) };
}

function totalForPhase(pb: Playback, busy: boolean, factor = 1): number {
  const ev = pb.item.event;
  const script = pb.script;
  switch (pb.phase) {
    case "dwell":
      return (busy ? BUSY_PAUSE_MS : DWELL_MS) / factor;
    case "hold":
      return (busy ? BUSY_PAUSE_MS : HOLD_MS) / factor;
    case "delete":
      return script.kind === "text" ? script.oldText.length : 0;
    case "read": {
      if (script.kind !== "read") return 0;
      const step = script.steps[pb.step];
      return step ? step.to - step.from + 1 : 0;
    }
    case "type":
      if (script.kind === "text") return script.newText.length;
      return ev.kind === "shell" ? ev.command.length : 0;
    case "output":
      return ev.kind === "shell" ? lineCount(ev.output ?? "") : 0;
    default:
      return 0;
  }
}

/** Units per millisecond for the current phase. */
function ratePerMs(pb: Playback, cps: number, factor: number): number {
  switch (pb.phase) {
    case "dwell":
    case "hold":
      return 1;
    case "delete": {
      const oldLength = pb.script.kind === "text" ? pb.script.oldText.length : 0;
      return Math.max(4 * cps, oldLength / MAX_DELETE_SEC) / 1000;
    }
    case "type":
      return cps / 1000;
    case "output":
      return (OUTPUT_LINES_PER_SEC * factor) / 1000;
    case "read":
      return (READ_LINES_PER_SEC * factor) / 1000;
    default:
      return 1;
  }
}

function nextPhase(pb: Playback): { phase: Phase; step: number } {
  if (pb.script.kind === "read") {
    if (pb.phase === "dwell") return { phase: "read", step: pb.step };
    return pb.step + 1 < pb.script.steps.length ? { phase: "dwell", step: pb.step + 1 } : { phase: "done", step: pb.step };
  }
  return { phase: nextTextPhase(pb), step: pb.step };
}

function nextTextPhase(pb: Playback): Phase {
  const { script, phase } = pb;
  if (script.kind === "text") {
    return ({ dwell: "delete", delete: "type", type: "hold", hold: "done" } as Record<Phase, Phase>)[phase] ?? "done";
  }
  if (script.kind === "shell") {
    if (phase === "type") return pb.item.event.status === "running" ? "done" : "output";
    return "done";
  }
  return "done";
}

function outputMs(ev: LiveEvent): number {
  return ev.kind === "shell" ? (lineCount(ev.output ?? "") / OUTPUT_LINES_PER_SEC) * 1000 : 0;
}

/**
 * Work left across current and queue at normal speed: characters to type (deletions count a
 * quarter) and milliseconds of pauses and output reveal.
 */
function remainingWork(s: PlayerState): { chars: number; fixedMs: number } {
  let chars = 0;
  let fixedMs = 0;
  for (const item of s.queue) {
    chars += item.chars;
    fixedMs += item.fixedMs;
  }
  const pb = s.current;
  if (pb && pb.script.kind === "read") {
    for (let i = pb.step; i < pb.script.steps.length; i++) {
      const step = pb.script.steps[i];
      const lines = step.to - step.from + 1 - (i === pb.step && pb.phase === "read" ? pb.progress : 0);
      fixedMs += (lines / READ_LINES_PER_SEC) * 1000 + (i === pb.step && pb.phase === "read" ? 0 : BUSY_PAUSE_MS);
    }
  } else if (pb) {
    const script = pb.script;
    const ev = pb.item.event;
    if (script.kind === "text") {
      const oldLeft = script.oldText.length - (pb.phase === "delete" ? pb.progress : 0);
      if (pb.phase === "dwell") chars += script.newText.length + script.oldText.length / 4;
      if (pb.phase === "delete") chars += script.newText.length + oldLeft / 4;
      if (pb.phase === "type") chars += script.newText.length - pb.progress;
      if (pb.phase !== "hold") fixedMs += BUSY_PAUSE_MS;
      fixedMs += BUSY_PAUSE_MS;
    } else if (script.kind === "diff") {
      fixedMs += BUSY_PAUSE_MS;
    } else if (script.kind === "shell") {
      if (pb.phase === "type") {
        chars += totalForPhase(pb, true) - pb.progress;
        if (ev.status !== "running") fixedMs += outputMs(ev);
      } else if (pb.phase === "output") {
        fixedMs += outputMs(ev) * (1 - pb.progress / Math.max(1, totalForPhase(pb, true)));
      }
    }
  }
  return { chars, fixedMs };
}

/** Typing speed and the shared catch-up factor for this tick. */
function currentPace(s: PlayerState): { cps: number; factor: number } {
  const oldest = s.current?.item.enqueuedAt ?? s.queue[0]?.enqueuedAt ?? s.clock;
  const ageSec = (s.clock - oldest) / 1000;
  const { chars, fixedMs } = remainingWork(s);
  const secondsLeft = Math.max(0.1, TARGET_LAG_SEC - ageSec);
  const factor = catchUpFactor(s.speed, chars, fixedMs / 1000, secondsLeft);
  return { cps: BASE_CPS * s.speed * factor, factor };
}

function prepare(event: LiveEvent, enqueuedAt: number): Queued {
  const script = buildScript(event);
  let chars = 0;
  let fixedMs = 0;
  if (script.kind === "text") {
    chars = script.newText.length + script.oldText.length / 4;
    fixedMs = 2 * BUSY_PAUSE_MS;
  } else if (script.kind === "diff") {
    fixedMs = BUSY_PAUSE_MS;
  } else if (script.kind === "shell" && event.kind === "shell") {
    chars = event.command.length;
    if (event.status !== "running") fixedMs = outputMs(event);
  }
  return { event, enqueuedAt, script, chars, fixedMs };
}

export type PhaseInfo = {
  key: string;
  kind: "text" | "diff" | "shell" | "instant" | "read";
  filePath: string | null;
  /** For reads: the review, diff or whole file, and the line being read. */
  reviewId: string | null;
  readMode: "diff" | "file" | null;
  cursorAt: number | null;
  phase: Phase;
  /** 0..1 through the current phase. */
  fraction: number;
};

/** What the current playback is doing, for the pointer overlay. Null when idle. */
export function currentPhase(s: PlayerState): PhaseInfo | null {
  const pb = s.current;
  if (!pb) return null;
  const total = totalForPhase(pb, s.queue.length > 0, s.factor);
  const script = pb.script;
  return {
    key: pb.item.event.key,
    kind: script.kind,
    filePath:
      script.kind === "text" || script.kind === "diff"
        ? script.filePath
        : script.kind === "read"
          ? script.steps[Math.min(pb.step, script.steps.length - 1)].path
          : null,
    reviewId: script.kind === "read" ? script.reviewId : null,
    readMode: script.kind === "read" ? script.mode : null,
    cursorAt: script.kind === "read" ? s.reader?.cursorAt ?? null : null,
    phase: pb.phase,
    fraction: total > 0 ? Math.min(1, pb.progress / total) : 1,
  };
}

function readCost(steps: ReadPlan["steps"]): number {
  return steps.reduce((ms, step) => ms + BUSY_PAUSE_MS + ((step.to - step.from + 1) / READ_LINES_PER_SEC) * 1000, 0);
}

/** Queue a review-mode reading: a diff's newly read lines, or a whole file at PR head. */
export function enqueueRead(
  s: PlayerState,
  effect: Extract<ReviewEffect, { kind: "read-diff" | "read-file" }>,
  plan: ReadPlan,
): PlayerState {
  if (plan.steps.length === 0) return s;
  const mode = effect.kind === "read-diff" ? "diff" : "file";
  const range = effect.kind === "read-diff" ? `${effect.from}-${effect.to}` : effect.path;
  const event: LiveEvent = {
    key: `read:${effect.reviewId}:${mode}:${range}:${s.clock}`,
    agentId: "",
    agentLabel: "",
    at: "",
    status: "completed",
    kind: "read",
    filePath: plan.steps[0].path,
    content: "",
    offset: null,
    limit: null,
  };
  const script: ReadScript = { kind: "read", reviewId: effect.reviewId, mode, steps: plan.steps };
  const item: Queued = { event, enqueuedAt: s.clock, script, chars: 0, fixedMs: readCost(plan.steps) };
  return { ...s, queue: [...s.queue, item] };
}

/** True when the editor, terminal, queue or controls would look different. */
export function visibleChanged(a: PlayerState, b: PlayerState): boolean {
  const clicked = (s: PlayerState) => {
    const pb = s.current;
    return !!pb && pb.phase === "dwell" && dwellFraction(s, pb) >= CLICK_AT;
  };
  return (
    a.current?.phase !== b.current?.phase ||
    clicked(a) !== clicked(b) ||
    a.editor !== b.editor ||
    a.reader !== b.reader ||
    a.terminal !== b.terminal ||
    a.touched !== b.touched ||
    a.queue.length !== b.queue.length ||
    a.current?.item.event.key !== b.current?.item.event.key ||
    a.paused !== b.paused ||
    a.speed !== b.speed
  );
}

// ---------- public API ----------

export function enqueue(s: PlayerState, event: LiveEvent): PlayerState {
  return {
    ...s,
    queue: [...s.queue, prepare(event, s.clock)],
    touched: addTouched(s.touched, event),
  };
}

export function seedHistory(s: PlayerState, events: LiveEvent[]): PlayerState {
  let next = s;
  for (const ev of events) {
    const entry = terminalEntryFor(ev, true);
    next = {
      ...next,
      done: keepLast([...next.done, slim(ev)]),
      touched: addTouched(next.touched, ev),
      terminal: entry ? upsertEntry(next.terminal, entry) : next.terminal,
    };
  }
  return next;
}

export function applyUpdate(s: PlayerState, ev: LiveEvent): PlayerState {
  const queue = s.queue.map((item) =>
    item.event.key === ev.key ? prepare(merge(item.event, ev), item.enqueuedAt) : item,
  );
  const done = s.done.map((d) => (d.key === ev.key ? slim(merge(d, ev)) : d));
  let current = s.current;
  if (current && current.item.event.key === ev.key) {
    current = { ...current, item: { ...current.item, event: merge(current.item.event, ev) } };
  }
  let terminal = s.terminal;
  const isPlaying = current?.item.event.key === ev.key;
  const existing = terminal.find((e) => e.key === ev.key);
  if (existing && !isPlaying && ev.kind === "shell") {
    const output = (ev as ShellEvent).output ?? "";
    terminal = upsertEntry(terminal, {
      ...existing,
      // The command text can arrive after the call started.
      command: (ev as ShellEvent).command || existing.command,
      typedCommand: (ev as ShellEvent).command || existing.typedCommand,
      status: ev.status,
      exitCode: ev.exitCode,
      output,
      shownOutputLines: lineCount(output),
      hiddenLines: ev.hiddenLines,
    });
  }
  return { ...s, queue, done, current, terminal };
}

export function tick(s: PlayerState, dtMs: number): PlayerState {
  if (s.paused || (!s.current && s.queue.length === 0)) return s.paused ? s : { ...s, clock: s.clock + dtMs };
  let state: PlayerState = { ...s, clock: s.clock + dtMs };
  const { cps, factor } = currentPace(state);
  state = state.factor === factor ? state : { ...state, factor };
  let left = dtMs;
  // Zero-length playbacks (instant ones) are consumed even when no time is left.
  for (let guard = 0; guard < 10000; guard++) {
    if (!state.current) {
      if (state.queue.length === 0) break;
      state = startNext(state);
    }
    const pb = state.current!;
    if (pb.phase === "done") {
      state = finish(state);
      continue;
    }
    if (left <= 0) break;
    const busy = state.queue.length > 0;
    const total = totalForPhase(pb, busy, factor);
    const rate = ratePerMs(pb, cps, factor);
    const needMs = (total - pb.progress) / rate;
    if (left >= needMs) {
      left -= needMs;
      const advanced: Playback = { ...pb, ...nextPhase(pb), progress: 0 };
      state = render({ ...state, current: advanced }, advanced);
    } else {
      const advanced: Playback = { ...pb, progress: pb.progress + left * rate };
      left = 0;
      state = render({ ...state, current: advanced }, advanced);
    }
  }
  return state;
}

export function setPaused(s: PlayerState, paused: boolean): PlayerState {
  return { ...s, paused };
}

export function setSpeed(s: PlayerState, speed: Speed): PlayerState {
  return { ...s, speed };
}

export function skipToLive(s: PlayerState): PlayerState {
  let state: PlayerState = { ...s };
  for (let guard = 0; guard < 100000 && (state.current || state.queue.length > 0); guard++) {
    if (!state.current) state = startNext(state);
    state = finish(state);
  }
  return state;
}

