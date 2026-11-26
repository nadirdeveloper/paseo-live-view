import type { ThoughtEvent } from "./events";

/** The thinking strip: the agent's latest thoughts and messages, typed out as they arrive. */

export type Thought = { key: string; agentId: string; agentLabel: string; source: "reasoning" | "message"; text: string; shown: number };
export type ThoughtLane = {
  items: Thought[];
  /** Agent whose last item was reasoning with nothing else since (so a new piece joins it). */
  openRun: string | null;
};

export const emptyLane: ThoughtLane = { items: [], openRun: null };

const MAX_THOUGHTS = 3;
const CHARS_PER_SEC = 150;

function finishAll(items: Thought[]): Thought[] {
  return items.map((t) => (t.shown === t.text.length ? t : { ...t, shown: t.text.length }));
}

export function addThought(l: ThoughtLane, ev: ThoughtEvent, opts: { instant: boolean }): ThoughtLane {
  const openRun = ev.source === "reasoning" ? ev.agentId : null;
  const same = l.items.findIndex((t) => t.key === ev.key);
  if (same !== -1) {
    const items = l.items.slice();
    const text = ev.text;
    items[same] = { ...items[same], text, shown: opts.instant ? text.length : Math.min(items[same].shown, text.length) };
    return { items, openRun };
  }
  const newest = l.items[l.items.length - 1];
  if (newest && newest.agentId === ev.agentId && newest.source === ev.source) {
    // A growing snapshot of the newest thought.
    if (ev.text.startsWith(newest.text)) {
      const items = l.items.slice(0, -1);
      items.push({ ...newest, key: ev.key, text: ev.text, shown: opts.instant ? ev.text.length : newest.shown });
      return { items, openRun };
    }
    // The next piece of the same run of reasoning.
    if (ev.source === "reasoning" && l.openRun === ev.agentId) {
      const items = l.items.slice(0, -1);
      const text = newest.text + ev.text;
      items.push({ ...newest, key: ev.key, text, shown: opts.instant ? text.length : newest.shown });
      return { items, openRun };
    }
  }
  const thought: Thought = {
    key: ev.key,
    agentId: ev.agentId,
    agentLabel: ev.agentLabel,
    source: ev.source,
    text: ev.text,
    shown: opts.instant ? ev.text.length : 0,
  };
  return { items: [...finishAll(l.items), thought].slice(-MAX_THOUGHTS), openRun };
}

/** Something else happened (a tool call, a message): the next reasoning starts a new thought. */
export function interrupt(l: ThoughtLane): ThoughtLane {
  return l.openRun === null ? l : { ...l, openRun: null };
}

export function tickThoughts(l: ThoughtLane, dtMs: number): ThoughtLane {
  const newest = l.items[l.items.length - 1];
  if (!newest || newest.shown >= newest.text.length) return l;
  const shown = Math.min(newest.text.length, newest.shown + Math.round((CHARS_PER_SEC * dtMs) / 1000));
  return { ...l, items: [...l.items.slice(0, -1), { ...newest, shown }] };
}
