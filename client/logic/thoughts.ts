import type { ThoughtEvent } from "./events";

/**
 * The thinking strip: the agent's latest thoughts and messages, typed out as they arrive.
 * Paseo streams both reasoning and messages in pieces, sometimes sharing one key, sometimes one
 * key per piece; a later full copy (history) can also arrive. All of these join into one thought.
 */

export type Thought = { key: string; agentId: string; agentLabel: string; source: "reasoning" | "message"; text: string; shown: number };
export type ThoughtLane = {
  items: Thought[];
  /** `${agentId}:${source}` of the newest thought while nothing else has happened for that agent. */
  openRun: string | null;
};

export const emptyLane: ThoughtLane = { items: [], openRun: null };

const MAX_THOUGHTS = 6;
const SUMMARY_CHARS = 140;

/**
 * One short plain line for the thinking strip: code blocks, tables and markdown removed, the first
 * heading or sentence kept, long text cut at a word.
 */
export function summarizeThought(text: string): string {
  const withoutBlocks = text.replace(/```[\s\S]*?(```|$)/g, "\n");
  const lines = withoutBlocks
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("|") && !/^[-*_]{3,}$/.test(l));
  const first = (lines[0] ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+|^\d+\.\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first);
  const plain = sentence ? sentence[1] : first;
  if (plain.length <= SUMMARY_CHARS) return plain;
  const cut = plain.slice(0, SUMMARY_CHARS);
  return cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : SUMMARY_CHARS) + "…";
}
const CHARS_PER_SEC = 150;

function finishAll(items: Thought[]): Thought[] {
  return items.map((t) => (t.shown === t.text.length ? t : { ...t, shown: t.text.length }));
}

/** A full copy replaces what we have; a piece is appended. */
function combine(current: string, incoming: string): string {
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return current + incoming;
}

export function addThought(l: ThoughtLane, ev: ThoughtEvent, opts: { instant: boolean }): ThoughtLane {
  const run = `${ev.agentId}:${ev.source}`;
  const same = l.items.findIndex((t) => t.key === ev.key);
  const newest = l.items[l.items.length - 1];
  const joins = same !== -1 || (newest && newest.agentId === ev.agentId && newest.source === ev.source && (l.openRun === run || ev.text.startsWith(newest.text)));
  if (joins) {
    const index = same !== -1 ? same : l.items.length - 1;
    const target = l.items[index];
    const text = combine(target.text, ev.text);
    const items = l.items.slice();
    items[index] = { ...target, key: ev.key, text, shown: opts.instant ? text.length : Math.min(target.shown, text.length) };
    return { items, openRun: run };
  }
  const thought: Thought = {
    key: ev.key,
    agentId: ev.agentId,
    agentLabel: ev.agentLabel,
    source: ev.source,
    text: ev.text,
    shown: opts.instant ? ev.text.length : 0,
  };
  return { items: [...finishAll(l.items), thought].slice(-MAX_THOUGHTS), openRun: run };
}

/** Something else happened for `agentId` (or anyone, when omitted): its next thought starts fresh. */
export function interrupt(l: ThoughtLane, agentId?: string): ThoughtLane {
  if (l.openRun === null) return l;
  if (agentId !== undefined && !l.openRun.startsWith(`${agentId}:`)) return l;
  return { ...l, openRun: null };
}

export function tickThoughts(l: ThoughtLane, dtMs: number): ThoughtLane {
  const newest = l.items[l.items.length - 1];
  if (!newest || newest.shown >= newest.text.length) return l;
  const shown = Math.min(newest.text.length, newest.shown + Math.round((CHARS_PER_SEC * dtMs) / 1000));
  return { ...l, items: [...l.items.slice(0, -1), { ...newest, shown }] };
}
