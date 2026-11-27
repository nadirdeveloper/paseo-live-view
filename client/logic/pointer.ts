import { AIM_CLICK_AT, CLICK_AT, currentPhase, type PlayerState } from "./player";

export type PointerTarget =
  | { kind: "tree"; path: string; click: boolean }
  /** click: set while aiming at the line before an edit (true = the pointer clicks it). */
  | { kind: "editor"; path: string; line: number; column: number; click?: boolean }
  | { kind: "terminal"; key: string }
  | { kind: "pr-file"; reviewId: string; path: string; click: boolean }
  | { kind: "diff"; line: number };


function cursorPosition(text: string, cursor: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < cursor && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: cursor - lineStart };
}

/** Where the mouse pointer should be for what the player is doing now; null when idle. */
export function pointerTarget(s: PlayerState): PointerTarget | null {
  const info = currentPhase(s);
  if (!info) return null;
  if (info.kind === "read") {
    if (info.phase === "dwell") return { kind: "pr-file", reviewId: info.reviewId!, path: info.filePath!, click: info.fraction >= CLICK_AT };
    // A whole file at PR head is shown in the editor; a diff in the diff view.
    if (info.readMode === "file") return { kind: "editor", path: info.filePath!, line: info.cursorAt ?? 1, column: 0 };
    return { kind: "diff", line: info.cursorAt ?? 1 };
  }
  if (info.kind === "shell" || info.kind === "instant") return { kind: "terminal", key: info.key };
  if (info.kind === "glance") return { kind: "tree", path: info.filePath!, click: false };
  if (info.kind === "view") {
    const path = info.filePath!;
    const at = { kind: "editor" as const, path, line: info.editLine ?? 1, column: 0 };
    if (info.phase === "dwell") return info.alreadyOpen ? { ...at, click: false } : { kind: "tree", path, click: info.fraction >= CLICK_AT };
    if (info.phase === "aim") return { ...at, click: info.fraction >= AIM_CLICK_AT };
    // Reading: the pointer follows the line being read.
    return { ...at, line: info.cursorAt ?? at.line };
  }
  const path = info.filePath!;
  if (info.kind === "text" && (info.phase === "dwell" || info.phase === "aim")) {
    const at = { kind: "editor" as const, path, line: info.editLine ?? 1, column: info.editColumn ?? 0 };
    if (info.phase === "aim") return { ...at, click: info.fraction >= AIM_CLICK_AT };
    // The file is already open: skip the tree and go straight to the line.
    if (info.alreadyOpen) return { ...at, click: false };
    return { kind: "tree", path, click: info.fraction >= CLICK_AT };
  }
  // Once the line is clicked the pointer stays put; only the text cursor moves while typing.
  if (info.kind === "text" && info.editLine !== null) {
    return { kind: "editor", path, line: info.editLine, column: info.editColumn ?? 0 };
  }
  const editor = s.editor;
  if (editor && editor.cursor !== null) return { kind: "editor", path, ...cursorPosition(editor.text, editor.cursor) };
  return { kind: "editor", path, line: editor?.highlight?.startLine ?? 1, column: 0 };
}

/** The pane the agent is working in, for the green "active" outline. */
export function activeArea(target: PointerTarget | null): "files" | "editor" | "terminal" | null {
  if (!target) return null;
  switch (target.kind) {
    case "tree":
    case "pr-file":
      return "files";
    case "editor":
    case "diff":
      return "editor";
    case "terminal":
      return "terminal";
  }
}
