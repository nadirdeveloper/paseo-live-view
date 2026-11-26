import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ThoughtLane } from "./logic/thoughts";
import type { Theme } from "./style";

type Props = { theme: Theme; lane: ThoughtLane; fill?: boolean };

/** The agent's latest thinking and messages, typed out as they stream. */
export const ThinkingStrip = memo(function ThinkingStrip({ theme, lane, fill = false }: Props) {
  const [open, setOpen] = useState(true);
  const items = lane.items;
  const newest = items[items.length - 1];
  const typing = newest && newest.shown < newest.text.length;
  return (
    <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, flex: fill ? 1 : undefined }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse thinking" : "Expand thinking"}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4 }}
      >
        <Icon name="Brain" size={12} color={typing ? theme.colors.accent : theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }}>
          {typing ? "Thinking…" : items.length ? "Thinking" : "No thoughts yet"}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open && items.length > 0 ? (
        <ScrollView style={{ maxHeight: fill ? undefined : 96 }} contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 6, gap: 4 }}>
          {items.map((t, i) => {
            const isNewest = i === items.length - 1;
            const reasoning = t.source === "reasoning";
            return (
              <View key={t.key} style={{ flexDirection: "row", gap: 6, opacity: isNewest ? 1 : 0.6 }}>
                <View style={{ paddingTop: 2 }}>
                  <Icon name={reasoning ? "Sparkles" : "MessageSquare"} size={11} color={theme.colors.foregroundMuted} />
                </View>
                <Text
                  numberOfLines={isNewest || fill ? undefined : 1}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    lineHeight: 17,
                    color: reasoning ? theme.colors.foregroundMuted : theme.colors.foreground,
                    fontStyle: reasoning ? "italic" : "normal",
                  }}
                >
                  {t.text.slice(0, t.shown)}
                  {isNewest && t.shown < t.text.length ? <Text style={{ color: theme.colors.accent }}>▍</Text> : null}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
});
