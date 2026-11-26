import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useContext, useRef, useState } from "react";
import { PointerContext } from "./PointerLayer";
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { TerminalEntry } from "./logic/player";
import { MONO, baseName, type Theme } from "./style";

type Props = { theme: Theme; entries: TerminalEntry[] };

/** Rows drawn at once; older ones stay in memory but off screen. */
const MAX_ROWS = 300;
const mono = { fontFamily: MONO, fontSize: 12, lineHeight: 17 };

/** One command; memoised so unchanged rows skip re-rendering while another row animates. */
const TerminalRow = memo(function TerminalRow({ theme, entry }: { theme: Theme; entry: TerminalEntry }) {
  const registerSpot = useContext(PointerContext);
        const typing = entry.kind === "shell" && entry.typedCommand.length < entry.command.length;
        const status =
          entry.kind === "failed-edit"
            ? { text: entry.status === "canceled" ? "canceled" : "failed", color: theme.colors.statusDanger }
            : entry.kind === "subagent"
              ? null
              : entry.status === "running"
                ? { text: "running…", color: theme.colors.statusWarning }
                : typing
                  ? null
                  : {
                      text: `exit ${entry.exitCode ?? "?"}`,
                      color: entry.exitCode === 0 ? theme.colors.statusSuccess : theme.colors.statusDanger,
                    };
        const prefix = entry.kind === "subagent" ? "" : entry.kind === "failed-edit" ? "edit " : "$ ";
        const icon =
          entry.kind === "subagent"
            ? { name: "Bot", color: theme.colors.accent }
            : entry.kind === "failed-edit"
              ? { name: "CircleX", color: theme.colors.statusDanger }
              : { name: "SquareTerminal", color: theme.colors.statusSuccess };
        const shown = entry.output.split("\n").slice(0, entry.shownOutputLines).join("\n");
        return (
          <View ref={(view) => registerSpot(`terminal:${entry.key}`, view)} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View style={{ paddingTop: 1 }}>
                <Icon name={icon.name} size={14} color={icon.color} />
              </View>
              <Text style={{ flex: 1, color: theme.colors.foreground, ...mono }}>
                <Text style={{ color: theme.colors.accent }}>{prefix}</Text>
                {entry.kind === "failed-edit" ? baseName(entry.typedCommand) : entry.typedCommand}
                {typing ? <Text style={{ color: theme.colors.accent }}>▍</Text> : null}
              </Text>
              {status ? <Text style={{ color: status.color, ...mono, fontSize: 11 }}>{status.text}</Text> : null}
              <Text style={{ color: theme.colors.foregroundMuted, ...mono, fontSize: 11 }}>{entry.agentLabel}</Text>
            </View>
            {entry.hiddenLines > 0 && entry.shownOutputLines > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, ...mono, fontSize: 11 }}>
                … {entry.hiddenLines} earlier lines hidden
              </Text>
            ) : null}
            {shown ? <Text style={{ color: theme.colors.foregroundMuted, ...mono }}>{shown}</Text> : null}
          </View>
        );
});

export const TerminalView = memo(function TerminalView({ theme, entries }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  // Follow new output until the user scrolls up; growing content alone never turns following off.
  const sticky = useRef(true);
  const lastY = useRef(0);
  const [following, setFollowing] = useState(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const movedUp = contentOffset.y < lastY.current - 2;
    lastY.current = contentOffset.y;
    if (fromBottom <= 40) sticky.current = true;
    else if (movedUp) sticky.current = false;
    if (sticky.current !== following) setFollowing(sticky.current);
  };

  const jumpToEnd = () => {
    sticky.current = true;
    setFollowing(true);
    scrollRef.current?.scrollToEnd({ animated: false });
  };

  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 10, gap: 10 }}
      onScroll={onScroll}
      scrollEventThrottle={32}
      onContentSizeChange={() => {
        if (sticky.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
    >
      {entries.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, ...mono }}>No commands yet.</Text>
      ) : null}
      {entries.length > MAX_ROWS ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 11 }}>
          … {entries.length - MAX_ROWS} earlier commands not shown
        </Text>
      ) : null}
      {entries.slice(-MAX_ROWS).map((entry) => (
        <TerminalRow key={entry.key} theme={theme} entry={entry} />
      ))}
    </ScrollView>
    {!following ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Jump to the latest command"
        onPress={jumpToEnd}
        style={{
          position: "absolute",
          right: 12,
          bottom: 10,
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 12,
          backgroundColor: theme.colors.accent,
        }}
      >
        <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>↓ latest</Text>
      </Pressable>
    ) : null}
    </View>
  );
});
