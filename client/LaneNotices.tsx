import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { laneNotices, type LaneInfo, type LaneNotice } from "./logic/subagents/lanes";
import type { Theme } from "./style";

const SHOW_MS = 20_000;
const MAX_SHOWN = 3;

type Shown = LaneNotice & { id: string };

/** Tells the user when a subagent starts or finishes, with a Watch button; never switches by itself. */
export function LaneNotices({ theme, lanes, watchingId, onWatch }: { theme: Theme; lanes: LaneInfo[]; watchingId: string | null; onWatch(id: string): void }) {
  const openedAt = useRef(Date.now()).current;
  const previous = useRef<LaneInfo[]>(lanes);
  const [notices, setNotices] = useState<Shown[]>([]);

  useEffect(() => {
    const found = laneNotices(previous.current, lanes, watchingId, openedAt);
    previous.current = lanes;
    if (found.length === 0) return;
    const fresh = found.map((n) => ({ ...n, id: `${n.laneId}:${n.kind}` }));
    setNotices((list) => [...list.filter((n) => !fresh.some((f) => f.laneId === n.laneId)), ...fresh].slice(-MAX_SHOWN));
    const timer = setTimeout(() => setNotices((list) => list.filter((n) => !fresh.some((f) => f.id === n.id))), SHOW_MS);
    return () => clearTimeout(timer);
  }, [lanes]);

  // Watching a lane clears its notice.
  useEffect(() => {
    setNotices((list) => (list.some((n) => n.laneId === watchingId) ? list.filter((n) => n.laneId !== watchingId) : list));
  }, [watchingId]);

  if (notices.length === 0) return null;
  return (
    <View style={{ gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      {notices.map((n) => {
        const color = n.kind === "failed" ? theme.colors.statusDanger : n.kind === "finished" ? theme.colors.statusSuccess : theme.colors.accent;
        const verb = n.kind === "started" ? "started" : n.kind === "finished" ? "finished" : "failed";
        return (
          <View
            key={n.id}
            accessibilityRole="alert"
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderLeftWidth: 3, borderLeftColor: color, backgroundColor: theme.colors.surface2 }}
          >
            <Icon name="GitBranch" size={13} color={color} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>
              Subagent {n.label} {verb}
              {n.task ? <Text style={{ color: theme.colors.foregroundMuted }}> · {n.task}</Text> : null}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Watch ${n.label}`}
              onPress={() => onWatch(n.laneId)}
              style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, backgroundColor: theme.colors.accent }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>Watch</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => setNotices((list) => list.filter((x) => x.id !== n.id))}
              style={{ padding: 3 }}
            >
              <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
