import { memo, useContext, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { TreeNode } from "./logic/fileTree";
import { fileIcon, folderIcon } from "./logic/icons";
import { PointerContext } from "./PointerLayer";
import { baseName, toneColor, type Theme } from "./style";

type Props = {
  theme: Theme;
  tree: TreeNode[];
  root: string | null;
  capped: boolean;
  touched: string[];
  /** Files a search just listed: pulsed for a moment. */
  glance?: string[] | null;
  activePath: string | null;
  onSelect(path: string): void;
};

function ancestors(path: string, root: string | null): string[] {
  if (!root || !path.startsWith(root + "/")) return [];
  const parts = path.slice(root.length + 1).split("/").slice(0, -1);
  return parts.map((_, i) => `${root}/${parts.slice(0, i + 1).join("/")}`);
}

export const FileTree = memo(function FileTree({ theme, tree, root, capped, touched, glance, activePath, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const registerSpot = useContext(PointerContext);
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const rowRefs = useRef(new Map<string, View>()).current;

  // Reveal the file the agent is working on (or the files a search listed).
  const revealPaths = glance && glance.length > 0 ? glance : activePath ? [activePath] : [];
  const revealKey = revealPaths.join("\n");
  useEffect(() => {
    if (revealPaths.length === 0) return;
    const first = revealPaths[0];
    const dirs = revealPaths.flatMap((p) => ancestors(p, root));
    setOpen((prev) => (dirs.every((d) => prev.has(d)) ? prev : new Set([...prev, ...dirs])));
    // Then bring its row into view, so the pointer lands inside the tree.
    const timer = setTimeout(() => {
      const row = rowRefs.get(first);
      const content = contentRef.current;
      if (!row || !content) return;
      row.measureLayout(
        content,
        (_x, y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: false }),
        () => {},
      );
    }, 30);
    return () => clearTimeout(timer);
  }, [revealKey, root]);

  const touchedSet = new Set(touched);
  const glanceSet = new Set(glance ?? []);
  const outside = touched.filter((p) => !root || !p.startsWith(root + "/"));

  const row = (node: TreeNode, depth: number) => {
    const isDir = node.children !== undefined;
    const isOpen = open.has(node.path);
    const active = node.path === activePath;
    const glanced = glanceSet.has(node.path);
    return (
      <View key={node.path}>
        <Pressable
          ref={
            isDir
              ? undefined
              : (view) => {
                  const v = view as View | null;
                  if (v) rowRefs.set(node.path, v);
                  else rowRefs.delete(node.path);
                  registerSpot(`tree:${node.path}`, v);
                }
          }
          accessibilityRole="button"
          accessibilityLabel={isDir ? `Folder ${node.name}` : `Open ${node.name}`}
          onPress={() => {
            if (isDir) {
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            } else {
              onSelect(node.path);
            }
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 3,
            paddingLeft: 8 + depth * 12,
            paddingRight: 8,
            backgroundColor: active || glanced ? theme.colors.surface2 : "transparent",
            borderLeftWidth: 2,
            borderLeftColor: glanced ? theme.colors.accent : "transparent",
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, width: 12, fontSize: 10 }}>
            {isDir ? (isOpen ? "▾" : "▸") : ""}
          </Text>
          {(() => {
            const choice = isDir ? folderIcon(isOpen) : fileIcon(node.name);
            return (
              <View style={{ width: 20 }}>
                <Icon name={choice.icon} size={14} color={toneColor(choice.tone, theme)} />
              </View>
            );
          })()}
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: active ? theme.colors.accent : theme.colors.foreground, fontSize: 13 }}
          >
            {node.name}
          </Text>
          {!isDir && touchedSet.has(node.path) ? (
            <Text style={{ color: theme.colors.accent, fontSize: 10 }}>●</Text>
          ) : null}
        </Pressable>
        {isDir && isOpen ? node.children!.map((child) => row(child, depth + 1)) : null}
      </View>
    );
  };

  const heading = (text: string) => (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        letterSpacing: 0.5,
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 4,
      }}
    >
      {text}
    </Text>
  );

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
      <View ref={contentRef}>
      {heading(root ? baseName(root).toUpperCase() : "FILES")}
      {tree.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 10, fontSize: 12 }}>Loading files…</Text>
      ) : (
        tree.map((node) => row(node, 0))
      )}
      {capped ? (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 10, paddingTop: 6, fontSize: 11 }}>
          Showing the first 5,000 files.
        </Text>
      ) : null}
      {outside.length > 0 ? (
        <>
          {heading("OUTSIDE WORKSPACE")}
          {outside.map((path) => row({ name: path, path }, 0))}
        </>
      ) : null}
      </View>
    </ScrollView>
  );
});
