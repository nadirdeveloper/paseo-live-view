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

/** Files a single change check types in; more than this (a branch switch, a formatter run) would bury the replay. */
export const MAX_TYPED_FILES = 10;

/**
 * True when an Edit/Write's result was already typed in from a change check (another lane's command
 * noticed the file first). Each remembered text is used once.
 */
export function alreadyShown(shown: Map<string, string>, ev: LiveEvent): boolean {
  if ((ev.kind !== "edit" && ev.kind !== "write") || ev.afterText == null) return false;
  if (shown.get(ev.filePath) !== ev.afterText) return false;
  shown.delete(ev.filePath);
  return true;
}
