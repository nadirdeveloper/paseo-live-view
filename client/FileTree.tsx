import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TreeNode } from "./logic/fileTree";
import { baseName, type Theme } from "./style";

type Props = {
  theme: Theme;
  tree: TreeNode[];
  root: string | null;
  capped: boolean;
  touched: string[];
  activePath: string | null;
  onSelect(path: string): void;
};

function ancestors(path: string, root: string | null): string[] {
  if (!root || !path.startsWith(root + "/")) return [];
  const parts = path.slice(root.length + 1).split("/").slice(0, -1);
  return parts.map((_, i) => `${root}/${parts.slice(0, i + 1).join("/")}`);
}

export const FileTree = memo(function FileTree({ theme, tree, root, capped, touched, activePath, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Reveal the file the agent is working on.
  useEffect(() => {
    if (!activePath) return;
    const dirs = ancestors(activePath, root);
    setOpen((prev) => (dirs.every((d) => prev.has(d)) ? prev : new Set([...prev, ...dirs])));
  }, [activePath, root]);

  const touchedSet = new Set(touched);
  const outside = touched.filter((p) => !root || !p.startsWith(root + "/"));

  const row = (node: TreeNode, depth: number) => {
    const isDir = node.children !== undefined;
    const isOpen = open.has(node.path);
    const active = node.path === activePath;
    return (
      <View key={node.path}>
        <Pressable
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
            backgroundColor: active ? theme.colors.surface2 : "transparent",
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, width: 14, fontSize: 11 }}>
            {isDir ? (isOpen ? "▾" : "▸") : ""}
          </Text>
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
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
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
    </ScrollView>
  );
});
