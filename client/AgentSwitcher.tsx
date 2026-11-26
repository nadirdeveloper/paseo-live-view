import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { depthOf, laneRole, type LaneInfo } from "./logic/subagents/lanes";
import type { Theme } from "./style";

type Props = {
  theme: Theme;
  lanes: LaneInfo[];
  selection: "main" | string;
  selectedId: string | null;
  onSelect(selection: "main" | string): void;
};

const STATUS_TEXT = { running: "working", done: "done", idle: "idle", failed: "failed" } as const;

function statusColor(status: LaneInfo["status"], theme: Theme): string {
  if (status === "done") return theme.colors.statusSuccess;
  if (status === "failed") return theme.colors.statusDanger;
  if (status === "idle") return theme.colors.foregroundMuted;
  return theme.colors.accent;
}

/** "Watching: …" dropdown to switch between the main agent, its subagents and theirs. */
export const AgentSwitcher = memo(function AgentSwitcher({ theme, lanes, selection, selectedId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  if (lanes.length <= 1) return null;

  const shown = lanes.find((l) => l.id === selectedId) ?? null;
  const describe = (lane: LaneInfo) => {
    const { role } = laneRole(lanes, lane.id);
    return `${role} · ${lane.label}`;
  };
  const current = shown ? describe(shown) : "Main agent";
  const working = lanes.filter((l) => l.kind === "subagent" && l.status === "running" && l.id !== selectedId).length;

  const pick = (value: "main" | string) => {
    onSelect(value);
    setOpen(false);
  };

  const row = (key: string, active: boolean, onPress: () => void, children: React.ReactNode, label: string) => (
    <Pressable
      key={key}
      accessibilityRole="menuitem"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 7, backgroundColor: active ? theme.colors.surface2 : "transparent", gap: 2 }}
    >
      {children}
    </Pressable>
  );

  return (
    // Sits above the panes so the open list can overlap them.
    <View style={{ zIndex: 20, borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Choose which agent to watch. Now: ${current}`}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6 }}
      >
        <Icon name="Users" size={13} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Watching:</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>
          {current}
        </Text>
        {working > 0 ? (
          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>● {working} subagent{working === 1 ? "" : "s"} working</Text>
        ) : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {lanes.length} agents {open ? "▴" : "▾"}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            position: "absolute",
            top: "100%",
            left: 8,
            right: 8,
            maxHeight: 340,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            overflow: "hidden",
          }}
        >
          <ScrollView>
            {lanes.map((lane) => {
              const { role, startedBy } = laneRole(lanes, lane.id);
              const depth = depthOf(lanes, lane.id);
              const active = selectedId === lane.id;
              return row(
                lane.id,
                active,
                () => pick(lane.id),
                <View style={{ paddingLeft: depth * 18, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {depth > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>↳</Text> : null}
                    <Icon name={lane.kind === "agent" ? "Bot" : "GitBranch"} size={13} color={theme.colors.foregroundMuted} />
                    <Text style={{ color: theme.colors.accent, fontSize: 10, letterSpacing: 0.5 }}>{role.toUpperCase()}</Text>
                    <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13 }}>
                      {lane.label}
                    </Text>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(lane.status, theme) }} />
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{STATUS_TEXT[lane.status]}</Text>
                    {active ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>● watching</Text> : null}
                  </View>
                  <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: depth > 0 ? 34 : 19 }}>
                    {[lane.task, startedBy ? `started by ${startedBy}` : null, lane.fallback ? "summary only" : null].filter(Boolean).join(" · ") || " "}
                  </Text>
                </View>,
                `${role} ${lane.label}${lane.task ? `: ${lane.task}` : ""}, ${STATUS_TEXT[lane.status]}${startedBy ? `, started by ${startedBy}` : ""}`,
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
});
