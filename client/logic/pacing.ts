import type { LiveEvent } from "./events";

export const BASE_CPS = 40;
export const TARGET_LAG_SEC = 15;

export type Speed = 0.5 | 1 | 2;

/**
 * Typing speed in characters per second: the chosen slow-motion speed, or faster when the
 * remaining characters would not otherwise finish within `secondsLeft`.
 */
export function effectiveCps(speed: Speed, remainingChars: number, secondsLeft = TARGET_LAG_SEC): number {
  return Math.max(BASE_CPS * speed, remainingChars / Math.max(secondsLeft, 0.001));
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
      return 0;
  }
}
