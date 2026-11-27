import type { LiveEvent } from "./events";

/** What the feed does once a tool call finishes: look for files it changed, and show what it read. */
export function afterCall(ev: LiveEvent): { checkChanges: boolean; reads: boolean } {
  const finished = ev.status === "completed" || ev.status === "failed";
  if (!finished) return { checkChanges: false, reads: false };
  switch (ev.kind) {
    case "shell":
    case "other":
      return { checkChanges: true, reads: true };
    case "read":
    case "search":
      return { checkChanges: false, reads: true };
    default:
      return { checkChanges: false, reads: false };
  }
}
