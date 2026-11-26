import type { ReviewState } from "./state";

/**
 * The mode to show. The user's pick holds until something new starts playing; otherwise it follows
 * what is playing (a read → Review, an edit → Code), then whatever played last, then the state's own
 * mode (history). `lastStartedKey` is the key of the most recent playback that started.
 */
export function displayMode(
  state: ReviewState,
  playing: "text" | "diff" | "read" | "shell" | "instant" | null,
  lastStartedKey: string | null,
  lastPlayed: "code" | "review" | null,
): "code" | "review" {
  if (state.manual && lastStartedKey === state.manualKey) return state.mode;
  if (playing === "read") return "review";
  if (playing === "text" || playing === "diff") return "code";
  return lastPlayed ?? state.mode;
}
