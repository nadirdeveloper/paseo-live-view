import { Pressable, Text, View } from "react-native";
import type { Speed } from "./logic/pacing";
import { type Theme } from "./style";

type Props = {
  theme: Theme;
  compact: boolean;
  paused: boolean;
  speed: Speed;
  queued: number;
  follow: boolean;
  onPause(): void;
  onPlay(): void;
  onSpeed(speed: Speed): void;
  onSkip(): void;
  onFollow(follow: boolean): void;
};

const SPEEDS: Speed[] = [0.5, 1, 2];

export function Controls(props: Props) {
  const { theme, compact, paused, speed, queued, follow } = props;
  const chip = (active: boolean) => ({
    paddingHorizontal: compact ? 8 : 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: active ? theme.colors.accent : theme.colors.border,
    backgroundColor: active ? theme.colors.accent : "transparent",
  });
  const chipText = (active: boolean) => ({
    color: active ? theme.colors.accentForeground : theme.colors.foreground,
    fontSize: 12,
  });
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={paused ? "Play replay" : "Pause replay"}
        onPress={paused ? props.onPlay : props.onPause}
        style={chip(paused)}
      >
        <Text style={chipText(paused)}>{paused ? "▶ Play" : "⏸ Pause"}</Text>
      </Pressable>
      {SPEEDS.map((s) => (
        <Pressable
          key={s}
          accessibilityRole="button"
          accessibilityLabel={`Replay speed ${s}x`}
          onPress={() => props.onSpeed(s)}
          style={chip(speed === s)}
        >
          <Text style={chipText(speed === s)}>{s}×</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Skip to live, ${queued} queued`}
        onPress={props.onSkip}
        style={chip(false)}
      >
        <Text style={chipText(false)}>⏭ live{queued > 0 ? ` (${queued} queued)` : ""}</Text>
      </Pressable>
      <View style={{ flex: 1 }} />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: follow }}
        accessibilityLabel="Follow agent"
        onPress={() => props.onFollow(!follow)}
        style={chip(follow)}
      >
        <Text style={chipText(follow)}>{follow ? "● Following agent" : "○ Follow agent"}</Text>
      </Pressable>
    </View>
  );
}
