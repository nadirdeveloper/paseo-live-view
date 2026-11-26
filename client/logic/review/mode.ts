import type { ReviewState } from "./state";

/**
 * The mode to show. The user's pick wins; otherwise it follows what is playing right now (a read →
 * Review, an edit → Code), then whatever played last, then the state's own mode (history).
 */
export function displayMode(
  state: ReviewState,
  playing: "text" | "diff" | "read" | "shell" | "instant" | null,
  lastPlayed: "code" | "review" | null,
): "code" | "review" {
  if (state.manual) return state.mode;
  if (playing === "read") return "review";
  if (playing === "text" || playing === "diff") return "code";
  return lastPlayed ?? state.mode;
}
