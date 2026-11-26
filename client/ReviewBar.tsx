import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { Review } from "./logic/review/state";
import type { Theme } from "./style";

type Props = {
  theme: Theme;
  mode: "code" | "review";
  review: Review | null;
  onMode(mode: "code" | "review"): void;
};

const VERDICTS = {
  ready: { label: "Ready to merge", tone: "statusSuccess" },
  "after-fixes": { label: "Merge after fixes", tone: "statusWarning" },
  "not-ready": { label: "Not ready", tone: "statusDanger" },
} as const;

/** Code / Review switch, the PR being reviewed, and its verdict. */
export function ReviewBar({ theme, mode, review, onMode }: Props) {
  const segment = (value: "code" | "review", label: string, icon: string, disabled: boolean) => {
    const active = mode === value;
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: active, disabled }}
        disabled={disabled}
        onPress={() => onMode(value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 6,
          backgroundColor: active ? theme.colors.accent : "transparent",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Icon name={icon} size={12} color={active ? theme.colors.accentForeground : theme.colors.foreground} />
        <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12 }}>{label}</Text>
      </Pressable>
    );
  };
  const verdict = review?.report?.verdict ? VERDICTS[review.report.verdict] : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", padding: 2, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}>
        {segment("code", "Code", "Code", false)}
        {segment("review", "Review", "GitPullRequest", !review)}
      </View>
      {review ? (
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>
          {review.label}
        </Text>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No PR review yet</Text>
      )}
      <View style={{ flex: 1 }} />
      {verdict ? (
        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: theme.colors[verdict.tone] }}>
          <Text style={{ color: theme.colors[verdict.tone], fontSize: 11 }}>{verdict.label}</Text>
        </View>
      ) : null}
    </View>
  );
}
