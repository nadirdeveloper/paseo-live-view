import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useContext } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { fileIcon } from "./logic/icons";
import type { Review } from "./logic/review/state";
import { PointerContext } from "./PointerLayer";
import { severityColor, type PlacedFinding } from "./reviewModel";
import { toneColor, type Theme } from "./style";

type Props = {
  theme: Theme;
  review: Review;
  findings: PlacedFinding[];
  activePath: string | null;
  onSelect(path: string): void;
};

/** The PR's changed files: +/−, how much the agent has read, and finding counts. */
export const PrFiles = memo(function PrFiles({ theme, review, findings, activePath, onSelect }: Props) {
  const registerSpot = useContext(PointerContext);
  const seen = new Set(review.files.map((f) => f.path));
  const notRead = (review.allFiles ?? []).filter((f) => !seen.has(f.path));
  const outside = [...new Set(findings.flatMap((p) => (p.placement.kind === "outside" ? [p.placement.path] : [])))];
  const listed = findings.filter((p) => p.placement.kind === "listed");

  const heading = (text: string) => (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, letterSpacing: 0.5, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 4 }}>
      {text}
    </Text>
  );

  const dots = (path: string) => {
    const mine = findings.filter((p) => (p.placement.kind === "pinned" || p.placement.kind === "outside") && p.placement.path === path);
    return mine.map((p) => (
      <Text key={p.finding.n} style={{ color: severityColor(p.finding.severity, theme), fontSize: 9 }}>
        ●
      </Text>
    ));
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
      {heading(`PR FILES (${review.files.length}${review.allFiles ? ` of ${review.allFiles.length}` : ""})`)}
      {review.files.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 10, fontSize: 12 }}>Waiting for the agent to read the diff…</Text>
      ) : null}
      {review.files.map((file) => {
        const coverage = review.coverage.find((c) => c.path === file.path);
        const share = coverage && coverage.total ? coverage.known / coverage.total : coverage?.partial ? 0.5 : 1;
        const active = file.path === activePath;
        const icon = fileIcon(file.path);
        return (
          <Pressable
            key={file.path}
            ref={(view) => registerSpot(`pr:${file.path}`, view as View | null)}
            accessibilityRole="button"
            accessibilityLabel={`Open diff of ${file.path}`}
            onPress={() => onSelect(file.path)}
            style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: active ? theme.colors.surface2 : "transparent", gap: 3 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name={icon.icon} size={13} color={toneColor(icon.tone, theme)} />
              <Text numberOfLines={1} style={{ flex: 1, color: active ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>
                {file.path}
              </Text>
              {dots(file.path)}
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 11 }}>+{file.adds}</Text>
              <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>−{file.dels}</Text>
            </View>
            <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
              <View style={{ width: `${Math.round(share * 100)}%`, height: 3, backgroundColor: coverage?.partial ? theme.colors.statusWarning : theme.colors.accent }} />
            </View>
          </Pressable>
        );
      })}
      {notRead.length > 0 ? heading("NOT READ BY THE AGENT") : null}
      {notRead.map((f) => (
        <Text key={f.path} numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 10, paddingVertical: 3 }}>
          {f.path}  +{f.adds} −{f.dels}
        </Text>
      ))}
      {listed.length > 0 ? heading("FINDINGS WITHOUT A LINE") : null}
      {listed.map((p) => (
        <Text key={p.finding.n} numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 12, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text style={{ color: severityColor(p.finding.severity, theme) }}>● </Text>#{p.finding.n} {p.finding.text}
        </Text>
      ))}
      {outside.length > 0 ? heading("OUTSIDE THIS PR") : null}
      {outside.map((path) => (
        <Pressable key={path} onPress={() => onSelect(path)} style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: path === activePath ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>
            {path}
          </Text>
          {dots(path)}
        </Pressable>
      ))}
    </ScrollView>
  );
});
