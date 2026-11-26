import { memo, useRef } from "react";
import { ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { TerminalEntry } from "./logic/player";
import { MONO, baseName, type Theme } from "./style";

type Props = { theme: Theme; entries: TerminalEntry[] };

/** Rows drawn at once; older ones stay in memory but off screen. */
const MAX_ROWS = 300;
const mono = { fontFamily: MONO, fontSize: 12, lineHeight: 17 };

/** One command; memoised so unchanged rows skip re-rendering while another row animates. */
const TerminalRow = memo(function TerminalRow({ theme, entry }: { theme: Theme; entry: TerminalEntry }) {
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
        const prefix = entry.kind === "subagent" ? "🤖 " : entry.kind === "failed-edit" ? "✗ edit " : "$ ";
        const shown = entry.output.split("\n").slice(0, entry.shownOutputLines).join("\n");
        return (
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
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

export function TerminalView({ theme, entries }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const atBottom = useRef(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
  };

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 10, gap: 10 }}
      onScroll={onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={() => {
        if (atBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
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
  );
}
