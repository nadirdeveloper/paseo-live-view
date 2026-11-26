import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PointerContext } from "./PointerLayer";
import { Pressable, ScrollView, Text, View } from "react-native";
import { START, languageFor, stateAfterLine, stateAt, tokenizeLine, type Lang, type LexState, type Token, type TokenKind } from "./logic/highlight";
import type { EditorFrame } from "./logic/player";
import { clipLine, visibleWindow } from "./logic/view";
import { Icon } from "@getpaseo/plugin/client/ui";
import { fileIcon } from "./logic/icons";
import { MONO, baseName, toneColor, type Theme } from "./style";

const LINE_HEIGHT = 18;
const SHOW_MORE = 200;

export type ManualView = { path: string; text: string | null; message: string | null };

type Props = { theme: Theme; compact: boolean; frame: EditorFrame | null; manual: ManualView | null };

function tokenColor(kind: TokenKind, theme: Theme): string {
  switch (kind) {
    case "keyword":
      return theme.colors.statusDanger;
    case "string":
      return theme.colors.statusSuccess;
    case "number":
    case "attr":
    case "property":
      return theme.colors.statusWarning;
    case "function":
    case "type":
    case "tag":
      return theme.colors.accent;
    case "comment":
    case "punctuation":
      return theme.colors.foregroundMuted;
    default:
      return theme.colors.foreground;
  }
}

const TOKEN_KINDS: TokenKind[] = [
  "plain", "keyword", "string", "number", "comment", "function", "type", "tag", "attr", "property", "punctuation",
];

type LineStyles = {
  tokens: Record<TokenKind, { color: string; fontStyle: "italic" | "normal" }>;
  caret: { color: string };
  gutter: object;
  gutterStrong: object;
  code: object;
  lit: object;
};

/** One set of style objects per theme, shared by every line. */
function makeStyles(theme: Theme): LineStyles {
  const tokens = {} as LineStyles["tokens"];
  for (const kind of TOKEN_KINDS) {
    tokens[kind] = { color: tokenColor(kind, theme), fontStyle: kind === "comment" ? "italic" : "normal" };
  }
  const gutter = { paddingRight: 10, textAlign: "right" as const, fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT };
  return {
    tokens,
    caret: { color: theme.colors.accent },
    gutter: { ...gutter, color: theme.colors.foregroundMuted },
    gutterStrong: { ...gutter, color: theme.colors.foreground },
    code: { flex: 1, color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT },
    lit: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: theme.colors.accent, opacity: 0.16 },
  };
}

/** Coloured spans for one line, with the text cursor glyph inserted at `cursorColumn`. */
function renderTokens(tokens: Token[], cursorColumn: number | null, styles: LineStyles) {
  const spans = [];
  let at = 0;
  let key = 0;
  const caret = <Text key="caret" style={styles.caret}>▍</Text>;
  let caretPlaced = cursorColumn === null;
  for (const token of tokens) {
    const style = styles.tokens[token.kind];
    const end = at + token.text.length;
    if (!caretPlaced && cursorColumn !== null && cursorColumn >= at && cursorColumn < end) {
      const split = cursorColumn - at;
      if (split > 0) spans.push(<Text key={key++} style={style}>{token.text.slice(0, split)}</Text>);
      spans.push(caret);
      spans.push(<Text key={key++} style={style}>{token.text.slice(split)}</Text>);
      caretPlaced = true;
    } else {
      spans.push(<Text key={key++} style={style}>{token.text}</Text>);
    }
    at = end;
  }
  if (!caretPlaced) spans.push(caret);
  return spans;
}

type LineProps = {
  n: number;
  content: string;
  lang: Lang | null;
  /** Lexer mode entering this line (a string so memo compares it cheaply). */
  carry: LexState["mode"];
  caret: number | null;
  lit: boolean;
  gutterWidth: number;
  pointerLine: boolean;
  styles: LineStyles;
};

/** One editor line; memoised so a typing frame only re-renders the line being typed. */
const Line = memo(function Line({ n, content, lang, carry, caret, lit, gutterWidth, pointerLine, styles }: LineProps) {
  const registerSpot = useContext(PointerContext);
  const tokens = lang ? tokenizeLine(content, lang, carry === "normal" ? START : { mode: carry }).tokens : null;
  return (
    <View
      ref={pointerLine ? (view) => registerSpot("editor:line", view, gutterWidth) : undefined}
      style={{ flexDirection: "row", minHeight: LINE_HEIGHT }}
    >
      {lit ? <View pointerEvents="none" style={styles.lit} /> : null}
      <Text style={[caret !== null || lit ? styles.gutterStrong : styles.gutter, { width: gutterWidth }]}>{n}</Text>
      <Text style={styles.code}>
        {tokens
          ? content
            ? renderTokens(tokens, caret, styles)
            : caret !== null
              ? renderTokens([], 0, styles)
              : " "
          : caret !== null ? (
            <>
              {content.slice(0, caret)}
              <Text style={styles.caret}>▍</Text>
              {content.slice(caret)}
            </>
          ) : (
            content || " "
          )}
      </Text>
    </View>
  );
});

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Memoised: while you browse a file yourself, agent ticks don't re-render it. */
export const EditorView = memo(function EditorView({ theme, compact, frame, manual }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const styles = useMemo(() => makeStyles(theme), [theme]);
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

  // Colours: work out the lexer state entering the window once, and reuse it while the text above
  // the window is unchanged (it is during typing, which happens inside the window).
  const lang = path ? languageFor(path) : null;
  const carryRef = useRef<{ key: string; state: LexState }>({ key: "", state: START });
  let carryIn: LexState = START;
  if (lang && first > 1) {
    const key = `${path}\u0000${lang}\u0000${first}\u0000${lines.slice(0, first - 1).join("\n")}`;
    if (carryRef.current.key !== key) carryRef.current = { key, state: stateAt(lines, lang, first - 1) };
    carryIn = carryRef.current.state;
  }

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
  let lexState = carryIn;
  for (let n = first; n <= last; n++) {
    const full = lines[n - 1] ?? "";
    const hasCursor = cursorLine === n;
    // Minified files can be one enormous line; draw only part of it.
    const clipped = clipLine(full, hasCursor ? cursorColumn : null);
    rows.push(
      <Line
        key={n}
        n={n}
        content={clipped.text}
        lang={lang}
        carry={lexState.mode}
        caret={hasCursor ? clipped.cursorColumn ?? 0 : null}
        lit={highlight !== null && n >= highlight.startLine && n <= highlight.endLine}
        gutterWidth={gutterWidth}
        pointerLine={n === (cursorLine ?? highlight?.startLine ?? -1)}
        styles={styles}
      />,
    );
    if (lang) lexState = stateAfterLine(full, lang, lexState);
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
        <Icon name={fileIcon(path).icon} size={14} color={toneColor(fileIcon(path).tone, theme)} />
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
});
