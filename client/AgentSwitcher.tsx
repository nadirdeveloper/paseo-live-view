import { Icon } from "@getpaseo/plugin/client/ui";
import { memo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { depthOf, type LaneInfo } from "./logic/subagents/lanes";
import type { Theme } from "./style";

type Props = {
  theme: Theme;
  lanes: LaneInfo[];
  selection: "auto" | string;
  selectedId: string | null;
  onSelect(selection: "auto" | string): void;
};

function statusColor(status: LaneInfo["status"], theme: Theme): string {
  if (status === "done") return theme.colors.statusSuccess;
  if (status === "failed") return theme.colors.statusDanger;
  if (status === "idle") return theme.colors.foregroundMuted;
  return theme.colors.accent;
}

/** Auto + one chip per agent and subagent (nested), each with a status dot. */
export const AgentSwitcher = memo(function AgentSwitcher({ theme, lanes, selection, selectedId, onSelect }: Props) {
  if (lanes.length <= 1) return null;
  const chip = (key: string, active: boolean, showing: boolean, children: React.ReactNode, onPress: () => void, label: string) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        borderWidth: showing ? 2 : 1,
        borderColor: showing ? theme.colors.statusSuccess : active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.surface2 : "transparent",
      }}
    >
      {children}
    </Pressable>
  );
  return (
    <View style={{ borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <ScrollView horizontal contentContainerStyle={{ gap: 6, paddingHorizontal: 10, paddingVertical: 5, alignItems: "center" }}>
        {chip(
          "auto",
          selection === "auto",
          false,
          <>
            <Icon name="Radar" size={12} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Auto</Text>
          </>,
          () => onSelect("auto"),
          "Follow whichever agent is active",
        )}
        {lanes.map((lane) => {
          const depth = depthOf(lanes, lane.id);
          return chip(
            lane.id,
            selection === lane.id,
            // In Auto, outline the lane Auto is showing.
            selection === "auto" && selectedId === lane.id,
            <>
              {depth > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{"↳".repeat(depth)}</Text> : null}
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(lane.status, theme) }} />
              <Icon name={lane.kind === "agent" ? "Bot" : "GitBranch"} size={12} color={theme.colors.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, maxWidth: 160 }}>
                {lane.label}
              </Text>
              {lane.task ? (
                <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, maxWidth: 160 }}>
                  {lane.task}
                </Text>
              ) : null}
            </>,
            () => onSelect(lane.id),
            `Show ${lane.label}${lane.task ? `: ${lane.task}` : ""}, ${lane.status}`,
          );
        })}
      </ScrollView>
    </View>
  );
});
