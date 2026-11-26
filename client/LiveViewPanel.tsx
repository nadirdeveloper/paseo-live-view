import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Controls } from "./Controls";
import { EditorView, type ManualView } from "./EditorView";
import { FileTree } from "./FileTree";
import { TerminalView } from "./TerminalView";
import { AgentFollowers, useLiveFeed } from "./useLiveFeed";

type Pane = "files" | "editor" | "terminal";

const READ_MESSAGES = {
  outside: "This file is outside the workspace.",
  missing: "This file no longer exists.",
  "too-large": "This file is too large to show (over 1 MiB).",
  binary: "This is a binary file.",
} as const;

export function LiveViewPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const feed = useLiveFeed(workspaceId);
  const { player } = feed;
  const compact = layout.compact;
  const [follow, setFollow] = useState(true);
  const [manual, setManual] = useState<ManualView | null>(null);
  const [pane, setPane] = useState<Pane>("editor");

  // Read the latest values through refs so openFile keeps one identity and FileTree can skip renders.
  const doneRef = useRef(player.done);
  doneRef.current = player.done;
  const readFileRef = useRef(feed.readFile);
  readFileRef.current = feed.readFile;
  const compactRef = useRef(compact);
  compactRef.current = compact;

  const openFile = useCallback(
    async (path: string) => {
      setFollow(false);
      setManual({ path, text: null, message: "Loading…" });
      if (compactRef.current) setPane("editor");
      const outsideEvent = doneRef.current.find((e) => (e.kind === "edit" || e.kind === "write") && e.filePath === path && !e.inWorkspace);
      if (outsideEvent && outsideEvent.kind === "write") {
        setManual({ path, text: outsideEvent.content ?? "", message: "Outside the workspace: shown from the agent's write." });
        return;
      }
      try {
        const result = await readFileRef.current(path);
        setManual(
          result.status === "ok" ? { path, text: result.text, message: null } : { path, text: null, message: READ_MESSAGES[result.status] },
        );
      } catch {
        setManual({ path, text: null, message: "Could not read this file." });
      }
    },
    [],
  );

  const onFollow = (next: boolean) => {
    setFollow(next);
    if (next) setManual(null);
  };

  const activePath = follow ? player.editor?.filePath ?? null : manual?.path ?? null;

  const tree = (
    <FileTree
      theme={theme}
      tree={feed.files.tree}
      root={feed.files.root}
      capped={feed.files.capped}
      touched={player.touched}
      activePath={activePath}
      onSelect={openFile}
    />
  );
  const editor = <EditorView theme={theme} compact={compact} frame={player.editor} manual={follow ? null : manual} />;
  const terminal = <TerminalView theme={theme} entries={player.terminal} />;
  const controls = (
    <Controls
      theme={theme}
      compact={compact}
      paused={player.paused}
      speed={player.speed}
      queued={player.queue.length + (player.current ? 1 : 0)}
      follow={follow}
      onPause={feed.pause}
      onPlay={feed.play}
      onSpeed={feed.setSpeed}
      onSkip={feed.skipToLive}
      onFollow={onFollow}
    />
  );

  if (compact) {
    const tab = (id: Pane, label: string) => (
      <Pressable
        key={id}
        accessibilityRole="tab"
        accessibilityState={{ selected: pane === id }}
        onPress={() => setPane(id)}
        style={{
          flex: 1,
          paddingVertical: 8,
          alignItems: "center",
          borderBottomWidth: 2,
          borderColor: pane === id ? theme.colors.accent : "transparent",
        }}
      >
        <Text style={{ color: pane === id ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <AgentFollowers feed={feed} />
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: theme.colors.border }}>
          {tab("files", "Files")}
          {tab("editor", "Editor")}
          {tab("terminal", `Terminal${player.terminal.length ? ` (${player.terminal.length})` : ""}`)}
        </View>
        <View style={{ flex: 1 }}>{pane === "files" ? tree : pane === "editor" ? editor : terminal}</View>
        {controls}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <AgentFollowers feed={feed} />
      <View style={{ flex: 65, flexDirection: "row" }}>
        <View style={{ width: 220, borderRightWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
          {tree}
        </View>
        <View style={{ flex: 1 }}>{editor}</View>
      </View>
      {controls}
      <View style={{ flex: 35 }}>{terminal}</View>
    </View>
  );
}
