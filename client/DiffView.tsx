import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { START, languageFor, tokenizeLine, type Lang, type TokenKind } from "./logic/highlight";
import { clipLine } from "./logic/view";
import { fileIcon } from "./logic/icons";
import type { ReaderFrame } from "./logic/player";
import type { DiffLine } from "./logic/review/diff";
import type { Review } from "./logic/review/state";
import { PointerContext } from "./PointerLayer";
import { SEVERITY_EMOJI, severityColor, type PlacedFinding } from "./reviewModel";
import { MONO, toneColor, type Theme } from "./style";

const LINE_HEIGHT = 18;
const WINDOW = 80;
const PAGE = 400;
const GUTTER = 38;

type Props = {
  theme: Theme;
  review: Review;
  path: string;
  /** Only passed when the agent is reading this file. */
  reader: ReaderFrame | null;
  findings: PlacedFinding[];
  /** Keep the reading line in view (off while the user browses). */
  follow: boolean;
};

function tokenColor(kind: TokenKind, theme: Theme): string {
  if (kind === "plain") return theme.colors.foreground;
  if (kind === "keyword") return theme.colors.statusDanger;
  if (kind === "string") return theme.colors.statusSuccess;
  if (kind === "comment" || kind === "punctuation") return theme.colors.foregroundMuted;
  if (kind === "number" || kind === "attr" || kind === "property") return theme.colors.statusWarning;
  return theme.colors.accent;
}

type RowProps = { theme: Theme; row: Row; lang: Lang | null; inBand: boolean; isCursor: boolean };

/** One diff row; memoised so a reading tick only re-renders the rows whose band/cursor changed. */
const DiffRow = memo(function DiffRow({ theme, row, lang, inBand, isCursor }: RowProps) {
  const registerSpot = useContext(PointerContext);
  if (row.kind === "gap") {
    return (
      <Text style={{ fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT, color: theme.colors.foregroundMuted, textAlign: "center", paddingVertical: 2 }}>
        ··· {row.count} {row.count === 1 ? "line" : "lines"} not read yet ···
      </Text>
    );
  }
  const mono = { fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT };
  const line = row.kind === "line" ? row.line : null;
  const tint = line?.kind === "add" ? theme.colors.statusSuccess : line?.kind === "del" ? theme.colors.statusDanger : null;
  const text = clipLine(row.kind === "line" ? row.line.text : row.text, null).text;
  let content;
  if (line) {
    const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
    const tokens = lang && line.kind !== "meta" ? tokenizeLine(text, lang, START).tokens : null;
    content = (
      <Text style={{ ...mono, flex: 1, color: theme.colors.foreground }}>
        <Text style={{ color: tint ?? theme.colors.foregroundMuted }}>{mark} </Text>
        {tokens ? tokens.map((t, k) => <Text key={k} style={{ color: tokenColor(t.kind, theme) }}>{t.text}</Text>) : text || " "}
      </Text>
    );
  } else {
    content = <Text style={{ ...mono, flex: 1, color: theme.colors.foregroundMuted }}>{text}</Text>;
  }
  return (
    <View ref={isCursor ? (view) => registerSpot("diff:line", view, GUTTER * 2) : undefined} style={{ flexDirection: "row", minHeight: LINE_HEIGHT }}>
      {tint ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: tint, opacity: 0.12 }} /> : null}
      {inBand ? <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: theme.colors.accent }} /> : null}
      {isCursor ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: theme.colors.accent, opacity: 0.18 }} /> : null}
      <Text style={{ ...mono, width: GUTTER, textAlign: "right", paddingRight: 6, color: theme.colors.foregroundMuted }}>{line?.oldNo ?? ""}</Text>
      <Text style={{ ...mono, width: GUTTER, textAlign: "right", paddingRight: 8, color: theme.colors.foregroundMuted }}>{line?.newNo ?? ""}</Text>
      {content}
    </View>
  );
});

type Row =
  | { kind: "gap"; at: number; count: number }
  | { kind: "meta"; at: number; text: string }
  | { kind: "hunk"; at: number; text: string }
  | { kind: "line"; at: number; line: DiffLine };

/** One PR file's diff as far as the agent has read it, with the reading band and pinned findings. */
export const DiffView = memo(function DiffView({ theme, review, path, reader, findings, follow }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [path]);
  const fileIndex = review.files.findIndex((f) => f.path === path);
  const file = review.files[fileIndex];
  const lang = languageFor(path);

  const rows = useMemo(() => {
    if (!file) return [] as Row[];
    const byAt = new Map<number, DiffLine>();
    const hunkAt = new Set<number>();
    for (const hunk of file.hunks) {
      hunkAt.add(hunk.at);
      for (const line of hunk.lines) byAt.set(line.at, line);
    }
    const next = review.files[fileIndex + 1];
    const end = next ? next.at - 1 : Math.max(file.endAt, review.doc.lines.length);
    const out: Row[] = [];
    for (let at = file.at; at <= end; at++) {
      const text = review.doc.lines[at - 1];
      if (text === undefined) {
        const last = out[out.length - 1];
        if (last?.kind === "gap") last.count++;
        else out.push({ kind: "gap", at, count: 1 });
      } else if (hunkAt.has(at)) out.push({ kind: "hunk", at, text });
      else if (byAt.has(at)) out.push({ kind: "line", at, line: byAt.get(at)! });
      else out.push({ kind: "meta", at, text });
    }
    return out;
  }, [file, fileIndex, review.doc, review.files]);

  // Only while the agent is actually reading this file (between files the cursor is null).
  const readingHere = reader && reader.mode === "diff" && reader.path === path && reader.cursorAt != null ? reader : null;
  const focusIndex = readingHere ? rows.findIndex((r) => r.at >= readingHere.cursorAt!) : -1;
  const following = follow && focusIndex >= 0;
  const first = following ? Math.max(0, focusIndex - WINDOW) : 0;
  const last = following ? Math.min(rows.length, focusIndex + WINDOW) : Math.min(rows.length, limit);

  // Keep the reading line in view; when reading stops, stay where we are.
  useEffect(() => {
    if (!following) return;
    const y = (focusIndex - first) * LINE_HEIGHT - 5 * LINE_HEIGHT;
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: false });
  }, [following, focusIndex, first, path]);

  const pinned = new Map<number, PlacedFinding[]>();
  for (const p of findings) {
    if (p.placement.kind === "pinned" && p.placement.path === path) {
      pinned.set(p.placement.diffAt, [...(pinned.get(p.placement.diffAt) ?? []), p]);
    }
  }
  const listed = findings.filter((p) => p.placement.kind === "listed");
  const outsideHere = findings.filter((p) => p.placement.kind === "outside" && p.placement.path === path);

  const card = (p: PlacedFinding) => (
    <View
      key={p.finding.n}
      style={{
        marginLeft: GUTTER * 2,
        marginRight: 10,
        marginVertical: 3,
        padding: 6,
        borderRadius: 6,
        borderLeftWidth: 3,
        borderLeftColor: severityColor(p.finding.severity, theme),
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
        {SEVERITY_EMOJI[p.finding.severity]} #{p.finding.n} {p.finding.decisionNeeded ? "Decision needed: " : ""}
        {p.finding.text}
      </Text>
      {p.finding.path ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          {p.finding.path}
          {p.finding.line ? `:${p.finding.line}` : ""}
        </Text>
      ) : null}
    </View>
  );

  const icon = fileIcon(path);
  const body = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    const inBand = readingHere !== null && row.at >= readingHere.from && row.at <= readingHere.cursorAt!;
    body.push(<DiffRow key={row.at} theme={theme} row={row} lang={lang} inBand={inBand} isCursor={i === focusIndex} />);
    for (const p of pinned.get(row.at) ?? []) body.push(card(p));
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <Icon name={icon.icon} size={14} color={toneColor(icon.tone, theme)} />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>{path}</Text>
        {file ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            <Text style={{ color: theme.colors.statusSuccess }}>+{file.adds}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{file.dels}</Text>
          </Text>
        ) : null}
        {readingHere ? <Text style={{ color: theme.colors.accent, fontSize: 11 }}>● reading</Text> : null}
      </View>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6 }}>
        {listed.length > 0 ? (
          <View style={{ paddingBottom: 6 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 12 }}>Findings without a line</Text>
            {listed.map(card)}
          </View>
        ) : null}
        {outsideHere.length > 0 ? (
          <View style={{ paddingBottom: 6 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 12 }}>Outside this PR</Text>
            {outsideHere.map(card)}
          </View>
        ) : null}
        {!file && outsideHere.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>This file isn't in the part of the diff the agent has read.</Text>
        ) : null}
        {body}
        {last < rows.length ? (
          following ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: GUTTER * 2 }}>… {rows.length - last} more lines</Text>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setLimit((l) => l + PAGE)}>
              <Text style={{ color: theme.colors.accent, fontSize: 11, paddingLeft: GUTTER * 2, paddingVertical: 4 }}>
                ↓ {rows.length - last} more lines · show more
              </Text>
            </Pressable>
          )
        ) : null}
      </ScrollView>
    </View>
  );
});
