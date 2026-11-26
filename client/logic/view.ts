/** Lines shown on each side of the focus line while following an agent. */
export const FOLLOW_WINDOW = 60;
/** Lines shown from the top of a file you opened yourself. */
export const MANUAL_LIMIT = 3000;
export const MAX_LINE_CHARS = 2000;

export function visibleWindow(input: {
  lineCount: number;
  focus: number | null;
  extraAbove: number;
  extraBelow: number;
}): { first: number; last: number } {
  const { lineCount, focus, extraAbove, extraBelow } = input;
  const total = Math.max(1, lineCount);
  if (focus === null) return { first: 1, last: Math.min(total, MANUAL_LIMIT + extraBelow) };
  return {
    first: Math.max(1, focus - FOLLOW_WINDOW - extraAbove),
    last: Math.min(total, focus + FOLLOW_WINDOW + extraBelow),
  };
}

/** Keep a very long line drawable: show at most `max` characters around the cursor. */
export function clipLine(
  content: string,
  cursorColumn: number | null,
  max = MAX_LINE_CHARS,
): { text: string; cursorColumn: number | null } {
  if (content.length <= max) return { text: content, cursorColumn };
  if (cursorColumn === null) return { text: content.slice(0, max) + "…", cursorColumn: null };
  let start = Math.max(0, cursorColumn - Math.floor(max / 2));
  const end = Math.min(content.length, start + max);
  start = Math.max(0, end - max);
  const lead = start > 0 ? "…" : "";
  return {
    text: lead + content.slice(start, end) + (end < content.length ? "…" : ""),
    cursorColumn: cursorColumn - start + lead.length,
  };
}
