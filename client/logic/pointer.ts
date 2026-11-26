import { CLICK_AT, currentPhase, type PlayerState } from "./player";

export type PointerTarget =
  | { kind: "tree"; path: string; click: boolean }
  | { kind: "editor"; path: string; line: number; column: number }
  | { kind: "terminal"; key: string };


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
  if (info.kind === "shell" || info.kind === "instant") return { kind: "terminal", key: info.key };
  const path = info.filePath!;
  if (info.kind === "text" && info.phase === "dwell") return { kind: "tree", path, click: info.fraction >= CLICK_AT };
  const editor = s.editor;
  if (editor && editor.cursor !== null) return { kind: "editor", path, ...cursorPosition(editor.text, editor.cursor) };
  return { kind: "editor", path, line: editor?.highlight?.startLine ?? 1, column: 0 };
}
