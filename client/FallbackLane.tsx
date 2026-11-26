import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { LaneInfo } from "./logic/subagents/lanes";
import type { Theme } from "./style";

/** Shown for a subagent whose transcript couldn't be found or read. */
export function FallbackLane({ theme, lane }: { theme: Theme; lane: LaneInfo }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <View style={{ maxWidth: 420, gap: 8, padding: 16, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="GitBranch" size={16} color={theme.colors.accent} />
          <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{lane.label}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>· {lane.status}</Text>
        </View>
        {lane.task ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{lane.task}</Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Full detail isn't available for this subagent.</Text>
      </View>
    </View>
  );
}
