import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { EditorFrame } from "./logic/player";
import { clipLine, visibleWindow } from "./logic/view";
import { MONO, baseName, type Theme } from "./style";

const LINE_HEIGHT = 18;
const SHOW_MORE = 200;

export type ManualView = { path: string; text: string | null; message: string | null };

type Props = { theme: Theme; compact: boolean; frame: EditorFrame | null; manual: ManualView | null };

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function EditorView({ theme, compact, frame, manual }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const path = manual?.path ?? frame?.filePath ?? null;
  const text = manual ? manual.text ?? "" : frame?.text ?? "";
  const cursor = manual ? null : frame?.cursor ?? null;
  const highlight = manual ? null : frame?.highlight ?? null;
  const note = manual ? manual.message : frame?.note ?? null;

  const lines = text.split("\n");
  const cursorLine = cursor === null ? null : lineOf(text, cursor);
  const cursorColumn = cursor === null ? 0 : cursor - (text.lastIndexOf("\n", cursor - 1) + 1);
  // A file you opened yourself shows from the top; while following, a window around the change.
  const focus = manual ? null : cursorLine ?? highlight?.startLine ?? 1;
  const [extra, setExtra] = useState({ above: 0, below: 0 });
  useEffect(() => setExtra({ above: 0, below: 0 }), [path, manual !== null]);
  const { first, last } = visibleWindow({
    lineCount: lines.length,
    focus,
    extraAbove: extra.above,
    extraBelow: extra.below,
  });

  // Keep the focus line in view as the cursor moves.
  useEffect(() => {
    const y = focus === null ? 0 : (focus - first) * LINE_HEIGHT - 4 * LINE_HEIGHT;
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: false });
  }, [focus, first, path]);

  if (!path) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted, textAlign: "center" }}>
          Waiting for an agent to edit a file…
        </Text>
      </View>
    );
  }

  const gutterWidth = Math.max(3, String(last).length) * 8 + 12;
  const rows = [];
  for (let n = first; n <= last; n++) {
    const lit = highlight !== null && n >= highlight.startLine && n <= highlight.endLine;
    const hasCursor = cursorLine === n;
    // Minified files can be one enormous line; draw only part of it.
    const clipped = clipLine(lines[n - 1] ?? "", hasCursor ? cursorColumn : null);
    const content = clipped.text;
    const column = clipped.cursorColumn ?? 0;
    rows.push(
      <View key={n} style={{ flexDirection: "row", minHeight: LINE_HEIGHT }}>
        {lit ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: theme.colors.accent, opacity: 0.16 }}
          />
        ) : null}
        <Text
          style={{
            width: gutterWidth,
            paddingRight: 10,
            textAlign: "right",
            color: hasCursor || lit ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: LINE_HEIGHT,
          }}
        >
          {n}
        </Text>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT }}>
          {hasCursor ? (
            <>
              {content.slice(0, column)}
              <Text style={{ color: theme.colors.accent }}>▍</Text>
              {content.slice(column)}
            </>
          ) : (
            content || " "
          )}
        </Text>
      </View>,
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
          {baseName(path)}
        </Text>
        {!manual && frame ? (
          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>
            {cursor !== null ? "● editing" : "edited"} ({frame.agentLabel})
          </Text>
        ) : null}
        {!compact ? (
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1, textAlign: "right" }}>
            {path}
          </Text>
        ) : null}
      </View>
      {note ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12, paddingHorizontal: 12, paddingVertical: 4 }}>{note}</Text>
      ) : null}
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6 }}>
        {first > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${Math.min(SHOW_MORE, first - 1)} more lines above`}
            onPress={() => setExtra((e) => ({ ...e, above: e.above + SHOW_MORE }))}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 11, paddingLeft: gutterWidth, paddingVertical: 2 }}>
              ↑ {first - 1} lines above · show more
            </Text>
          </Pressable>
        ) : null}
        {rows}
        {last < lines.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${Math.min(SHOW_MORE, lines.length - last)} more lines below`}
            onPress={() => setExtra((e) => ({ ...e, below: e.below + SHOW_MORE }))}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 11, paddingLeft: gutterWidth, paddingVertical: 2 }}>
              ↓ {lines.length - last} lines below · show more
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
