import type { LiveEvent } from "./events";

export const BASE_CPS = 40;
export const TARGET_LAG_SEC = 15;

export type Speed = 0.5 | 1 | 2;

/**
 * Typing speed in characters per second: the chosen slow-motion speed, or faster when the
 * remaining characters would not otherwise finish within `secondsLeft`.
 */
export function effectiveCps(speed: Speed, remainingChars: number, secondsLeft = TARGET_LAG_SEC): number {
  return BASE_CPS * speed * catchUpFactor(speed, remainingChars, 0, secondsLeft);
}

/**
 * How many times faster than normal everything (typing, pauses, output) must run so the remaining
 * work — `remainingChars` typed at the chosen speed plus `fixedSec` of pauses and output reveal —
 * fits in `secondsLeft`. Never below 1: calm moments stay in slow motion.
 */
export function catchUpFactor(speed: Speed, remainingChars: number, fixedSec: number, secondsLeft: number): number {
  const needed = remainingChars / (BASE_CPS * speed) + fixedSec;
  return Math.max(1, needed / Math.max(secondsLeft, 0.001));
}

function isFinalFailure(ev: LiveEvent): boolean {
  return ev.status === "failed" || ev.status === "canceled";
}

/** Characters this event will type out when replayed. */
export function eventChars(ev: LiveEvent): number {
  switch (ev.kind) {
    case "edit":
      return isFinalFailure(ev) ? 0 : (ev.newString ?? "").length;
    case "write":
      return isFinalFailure(ev) ? 0 : (ev.content ?? ev.afterText ?? "").length;
    case "shell":
      return ev.command.length;
    case "subagent":
    case "read":
    case "thought":
      return 0;
  }
}
