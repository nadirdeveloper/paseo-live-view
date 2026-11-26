import type { LiveEvent, ShellEvent } from "./events";
import { TARGET_LAG_SEC, effectiveCps, type Speed } from "./pacing";
import { reconstructEdit } from "./reconstruct";

export type EditorFrame = {
  filePath: string;
  agentLabel: string;
  text: string;
  cursor: number | null;
  highlight: { startLine: number; endLine: number } | null;
  note: string | null;
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

type Queued = { event: LiveEvent; enqueuedAt: number };

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
type Script = TextScript | DiffScript | { kind: "shell" } | { kind: "instant" };

type Phase = "dwell" | "delete" | "type" | "hold" | "output" | "done";

type Playback = { item: Queued; script: Script; phase: Phase; progress: number };

export type PlayerState = {
  queue: Queued[];
  current: Playback | null;
  done: LiveEvent[];
  paused: boolean;
  speed: Speed;
  clock: number;
  editor: EditorFrame | null;
  terminal: TerminalEntry[];
  touched: string[];
};

const DWELL_MS = 300;
const HOLD_MS = 500;
const BUSY_PAUSE_MS = 100;
const OUTPUT_LINES_PER_SEC = 100;
const MAX_DELETE_SEC = 1;

export function createPlayer(): PlayerState {
  return {
    queue: [],
    current: null,
    done: [],
    paused: false,
    speed: 1,
    clock: 0,
    editor: null,
    terminal: [],
    touched: [],
  };
}

// ---------- helpers ----------

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
  if (ev.kind === "subagent" || isFailure(ev)) return { kind: "instant" };
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
    note: rec.reason === "no-snapshot" ? "file content unavailable" : "file has changed since",
    highlightResult: true,
  };
}

function firstPhase(script: Script): Phase {
  switch (script.kind) {
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
  if (isFailure(ev)) {
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
  if (index === -1) return [...terminal, entry];
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
  if (script.kind === "text") return { ...s, editor: textFrame(script, ev, phase, progress) };
  if (script.kind === "diff") {
    return {
      ...s,
      editor: {
        filePath: script.filePath,
        agentLabel: ev.agentLabel,
        text: script.after,
        cursor: null,
        highlight: script.highlight,
        note: null,
      },
    };
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
    return { ...s, terminal: upsertEntry(s.terminal, entry) };
  }
  return s;
}

function startNext(s: PlayerState): PlayerState {
  const [item, ...queue] = s.queue;
  const script = buildScript(item.event);
  const pb: Playback = { item, script, phase: firstPhase(script), progress: 0 };
  let next: PlayerState = { ...s, queue, current: pb };
  if (script.kind === "instant") {
    const entry = terminalEntryFor(item.event, true);
    if (entry) next = { ...next, terminal: upsertEntry(next.terminal, entry) };
  }
  return render(next, pb);
}

function finish(s: PlayerState): PlayerState {
  const pb = s.current!;
  const rendered = render(s, { ...pb, phase: "done" });
  return { ...rendered, current: null, done: [...s.done, pb.item.event] };
}

function totalForPhase(pb: Playback, busy: boolean): number {
  const ev = pb.item.event;
  const script = pb.script;
  switch (pb.phase) {
    case "dwell":
      return busy ? BUSY_PAUSE_MS : DWELL_MS;
    case "hold":
      return busy ? BUSY_PAUSE_MS : HOLD_MS;
    case "delete":
      return script.kind === "text" ? script.oldText.length : 0;
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
function ratePerMs(pb: Playback, cps: number): number {
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
      return OUTPUT_LINES_PER_SEC / 1000;
    default:
      return 1;
  }
}

function nextPhase(pb: Playback): Phase {
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

/** Remaining characters (typed + a quarter of deleted) across current and queue. */
function remainingWork(s: PlayerState): { chars: number; fixedMs: number } {
  let chars = 0;
  let fixedMs = 0;
  const count = (ev: LiveEvent) => {
    const script = buildScript(ev);
    if (script.kind === "text") {
      chars += script.newText.length + script.oldText.length / 4;
      fixedMs += 2 * BUSY_PAUSE_MS;
    } else if (script.kind === "diff") {
      fixedMs += BUSY_PAUSE_MS;
    } else if (script.kind === "shell" && ev.kind === "shell") {
      chars += ev.command.length;
      fixedMs += (lineCount(ev.output ?? "") / OUTPUT_LINES_PER_SEC) * 1000;
    }
  };
  if (s.current) {
    const pb = s.current;
    const script = pb.script;
    if (script.kind === "text") {
      if (pb.phase === "dwell" || pb.phase === "delete") {
        chars += script.newText.length + (script.oldText.length - (pb.phase === "delete" ? pb.progress : 0)) / 4;
      } else if (pb.phase === "type") {
        chars += script.newText.length - pb.progress;
      }
    } else if (script.kind === "shell" && pb.phase === "type") {
      chars += totalForPhase(pb, true) - pb.progress;
    }
  }
  for (const item of s.queue) count(item.event);
  return { chars, fixedMs };
}

function currentCps(s: PlayerState): number {
  const oldest = s.current?.item.enqueuedAt ?? s.queue[0]?.enqueuedAt ?? s.clock;
  const ageSec = (s.clock - oldest) / 1000;
  const { chars, fixedMs } = remainingWork(s);
  const secondsLeft = Math.max(0.1, TARGET_LAG_SEC - ageSec - fixedMs / 1000);
  return effectiveCps(s.speed, chars, secondsLeft);
}

// ---------- public API ----------

export function enqueue(s: PlayerState, event: LiveEvent): PlayerState {
  return {
    ...s,
    queue: [...s.queue, { event, enqueuedAt: s.clock }],
    touched: addTouched(s.touched, event),
  };
}

export function seedHistory(s: PlayerState, events: LiveEvent[]): PlayerState {
  let next = s;
  for (const ev of events) {
    const entry = terminalEntryFor(ev, true);
    next = {
      ...next,
      done: [...next.done, ev],
      touched: addTouched(next.touched, ev),
      terminal: entry ? upsertEntry(next.terminal, entry) : next.terminal,
    };
  }
  return next;
}

export function applyUpdate(s: PlayerState, ev: LiveEvent): PlayerState {
  const queue = s.queue.map((item) => (item.event.key === ev.key ? { ...item, event: merge(item.event, ev) } : item));
  const done = s.done.map((d) => (d.key === ev.key ? merge(d, ev) : d));
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
  const cps = currentCps(state);
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
    const total = totalForPhase(pb, busy);
    const rate = ratePerMs(pb, cps);
    const needMs = (total - pb.progress) / rate;
    if (left >= needMs) {
      left -= needMs;
      const advanced: Playback = { ...pb, phase: nextPhase(pb), progress: 0 };
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

