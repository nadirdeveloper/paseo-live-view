import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useContext, useEffect, useMemo, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { START, languageFor, tokenizeLine } from "./logic/highlight";
import { fileIcon } from "./logic/icons";
import type { ReaderFrame } from "./logic/player";
import type { DiffLine } from "./logic/review/diff";
import type { Review } from "./logic/review/state";
import { PointerContext } from "./PointerLayer";
import { SEVERITY_EMOJI, severityColor, type PlacedFinding } from "./reviewModel";
import { MONO, toneColor, type Theme } from "./style";

const LINE_HEIGHT = 18;
const WINDOW = 80;
const MANUAL_LIMIT = 3000;
const GUTTER = 38;

type Props = { theme: Theme; review: Review; path: string; reader: ReaderFrame | null; findings: PlacedFinding[] };

type Row =
  | { kind: "gap"; at: number; count: number }
  | { kind: "meta"; at: number; text: string }
  | { kind: "hunk"; at: number; text: string }
  | { kind: "line"; at: number; line: DiffLine };

/** One PR file's diff as far as the agent has read it, with the reading band and pinned findings. */
export const DiffView = memo(function DiffView({ theme, review, path, reader, findings }: Props) {
  const registerSpot = useContext(PointerContext);
  const scrollRef = useRef<ScrollView>(null);
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

  const readingHere = reader && reader.mode === "diff" && reader.path === path ? reader : null;
  const focusIndex = readingHere?.cursorAt != null ? rows.findIndex((r) => r.at >= readingHere.cursorAt!) : -1;
  const first = focusIndex >= 0 ? Math.max(0, focusIndex - WINDOW) : 0;
  const last = focusIndex >= 0 ? Math.min(rows.length, focusIndex + WINDOW) : Math.min(rows.length, MANUAL_LIMIT);

  useEffect(() => {
    const y = focusIndex >= 0 ? (focusIndex - first) * LINE_HEIGHT - 5 * LINE_HEIGHT : 0;
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: false });
  }, [focusIndex, first, path]);

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

  const mono = { fontFamily: MONO, fontSize: 12, lineHeight: LINE_HEIGHT };
  const icon = fileIcon(path);
  const body = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    if (row.kind === "gap") {
      body.push(
        <Text key={`g${row.at}`} style={{ ...mono, color: theme.colors.foregroundMuted, textAlign: "center", paddingVertical: 2 }}>
          ··· {row.count} {row.count === 1 ? "line" : "lines"} not read yet ···
        </Text>,
      );
      continue;
    }
    const inBand = readingHere !== null && row.at >= readingHere.from && row.at <= (readingHere.cursorAt ?? readingHere.to);
    const isCursor = readingHere?.cursorAt != null && i === focusIndex;
    const tint =
      row.kind === "line" && row.line.kind === "add"
        ? theme.colors.statusSuccess
        : row.kind === "line" && row.line.kind === "del"
          ? theme.colors.statusDanger
          : null;
    let content;
    if (row.kind === "line") {
      const mark = row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " ";
      const tokens = lang && row.line.kind !== "meta" ? tokenizeLine(row.line.text, lang, START).tokens : null;
      content = (
        <Text style={{ ...mono, flex: 1, color: theme.colors.foreground }}>
          <Text style={{ color: tint ?? theme.colors.foregroundMuted }}>{mark} </Text>
          {tokens
            ? tokens.map((t, k) => (
                <Text key={k} style={{ color: t.kind === "plain" ? theme.colors.foreground : t.kind === "keyword" ? theme.colors.statusDanger : t.kind === "string" ? theme.colors.statusSuccess : t.kind === "comment" || t.kind === "punctuation" ? theme.colors.foregroundMuted : t.kind === "number" || t.kind === "attr" || t.kind === "property" ? theme.colors.statusWarning : theme.colors.accent }}>
                  {t.text}
                </Text>
              ))
            : row.line.text || " "}
        </Text>
      );
    } else {
      content = <Text style={{ ...mono, flex: 1, color: theme.colors.foregroundMuted }}>{row.text}</Text>;
    }
    body.push(
      <View key={row.at} ref={isCursor ? (view) => registerSpot("diff:line", view, GUTTER * 2) : undefined} style={{ flexDirection: "row", minHeight: LINE_HEIGHT }}>
        {tint ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: tint, opacity: 0.12 }} /> : null}
        {inBand ? <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: theme.colors.accent }} /> : null}
        {isCursor ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: theme.colors.accent, opacity: 0.18 }} /> : null}
        <Text style={{ ...mono, width: GUTTER, textAlign: "right", paddingRight: 6, color: theme.colors.foregroundMuted }}>
          {row.kind === "line" && row.line.oldNo !== null ? row.line.oldNo : ""}
        </Text>
        <Text style={{ ...mono, width: GUTTER, textAlign: "right", paddingRight: 8, color: theme.colors.foregroundMuted }}>
          {row.kind === "line" && row.line.newNo !== null ? row.line.newNo : ""}
        </Text>
        {content}
      </View>,
    );
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
        {listed.length > 0 && fileIndex === 0 ? (
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
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: GUTTER * 2 }}>… {rows.length - last} more lines</Text>
        ) : null}
      </ScrollView>
    </View>
  );
});
