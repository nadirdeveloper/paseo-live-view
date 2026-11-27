import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { AgentSwitcher } from "./AgentSwitcher";
import { Controls } from "./Controls";
import { FallbackLane } from "./FallbackLane";
import { LaneNotices } from "./LaneNotices";
import { SubagentFollowers } from "./SubagentFollower";
import { DiffView } from "./DiffView";
import { PrFiles } from "./PrFiles";
import { ReviewBar } from "./ReviewBar";
import { placedFindings } from "./reviewModel";
import { ThinkingStrip } from "./ThinkingStrip";
import { EditorView, type ManualView } from "./EditorView";
import { FileTree } from "./FileTree";
import { currentPhase } from "./logic/player";
import { activeArea, pointerTarget } from "./logic/pointer";
import { displayMode } from "./logic/review/mode";
import { Splitter } from "./Splitter";
import { PointerContext, PointerLayer, createRegister, type PointerRegistry } from "./PointerLayer";
import { TerminalView } from "./TerminalView";
import { AgentFollowers, useLiveFeed } from "./useLiveFeed";

type Pane = "files" | "editor" | "terminal" | "thinking";

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
  const rootRef = useRef<View>(null);
  const registry = useRef<PointerRegistry>(new Map()).current;
  const register = useMemo(() => createRegister(registry), [registry]);
  const target = useMemo(() => (follow ? pointerTarget(player) : null), [player, follow]);
  // The pane the agent is working in gets a green outline.
  const area = activeArea(target);
  const outline = (name: "files" | "editor" | "terminal") => ({
    borderWidth: 2,
    borderRadius: 4,
    borderColor: area === name ? theme.colors.statusSuccess : "transparent",
  });

  // Review mode: the newest review, its findings, and which file is shown.
  const { review: reviewState } = feed;
  // Show what is playing now (a read → Review, an edit → Code), unless the user picked a mode.
  const phase = currentPhase(player);
  const playing = phase?.kind ?? null;
  const lastPlayed = useRef<"code" | "review" | null>(null);
  const lastStartedKey = useRef<string | null>(null);
  if (phase) lastStartedKey.current = phase.key;
  if (playing === "read") lastPlayed.current = "review";
  else if (playing === "text" || playing === "diff" || playing === "view" || playing === "glance") lastPlayed.current = "code";
  // These remember things about the lane on screen; start fresh when switching to another agent.
  const shownLane = useRef(feed.selectedId);
  if (shownLane.current !== feed.selectedId) {
    shownLane.current = feed.selectedId;
    lastPlayed.current = null;
    lastStartedKey.current = phase?.key ?? null;
  }
  const mode = displayMode(reviewState, playing, lastStartedKey.current, lastPlayed.current);
  const inReview = mode === "review";
  // Resizable panes (px).
  const [treeWidth, setTreeWidth] = useState(240);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [thinkingHeight, setThinkingHeight] = useState(96);
  const review = reviewState.reviews.find((r) => r.id === reviewState.activeId) ?? reviewState.reviews[reviewState.reviews.length - 1] ?? null;
  const findings = useMemo(() => placedFindings(review), [review]);
  const [prSelection, setPrSelection] = useState<string | null>(null);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const reader = player.reader && review && player.reader.reviewId === review.id ? player.reader : null;
  // Keep showing the last file read after reading finishes, instead of jumping to the first file.
  const lastReadPath = useRef<string | null>(null);
  const readLane = useRef(feed.selectedId);
  if (readLane.current !== feed.selectedId) {
    readLane.current = feed.selectedId;
    lastReadPath.current = null;
    if (prSelection !== null) setPrSelection(null);
  }
  if (reader) lastReadPath.current = reader.path;
  const prPath = follow ? reader?.path ?? lastReadPath.current ?? review?.files[0]?.path ?? null : prSelection ?? lastReadPath.current ?? review?.files[0]?.path ?? null;
  const selectPr = useCallback((path: string) => {
    setFollow(false);
    setPrSelection(path);
    if (compactRef.current) setPane("editor");
  }, []);
  const headText = review && prPath ? review.headFiles.get(prPath) : undefined;
  const readingHeadFile = reader?.mode === "file" && reader.path === prPath;
  const headFrame = useMemo(
    () =>
      prPath && headText !== undefined
        ? {
            filePath: prPath,
            agentLabel: "reading at PR head",
            text: headText,
            cursor: null,
            highlight: readingHeadFile && reader?.cursorAt != null ? { startLine: reader.from, endLine: reader.cursorAt } : null,
            note: null,
            focusLine: readingHeadFile ? reader?.cursorAt ?? null : null,
          }
        : null,
    [prPath, headText, readingHeadFile, reader?.from, reader?.cursorAt],
  );

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
    if (next) {
      setManual(null);
      setPrSelection(null);
    }
  };

  const activePath = follow ? player.editor?.filePath ?? null : manual?.path ?? null;

  const tree = (
    <FileTree
      theme={theme}
      tree={feed.files.tree}
      root={feed.files.root}
      capped={feed.files.capped}
      touched={player.touched}
      glance={player.glance}
      activePath={activePath}
      onSelect={openFile}
    />
  );
  const codeEditor = <EditorView theme={theme} compact={compact} frame={follow ? player.editor : null} manual={follow ? null : manual} />;
  // In review mode: a file fetched at PR head shows in the editor with the reading band; otherwise the diff.
  const reviewMain =
    review && prPath ? (
      headFrame && (readingHeadFile || !review.files.some((f) => f.path === prPath)) ? (
        <EditorView theme={theme} compact={compact} frame={headFrame} manual={null} />
      ) : (
        <DiffView
          theme={theme}
          review={review}
          path={prPath}
          reader={reader && reader.path === prPath ? reader : null}
          findings={findings}
          follow={follow}
        />
      )
    ) : null;
  const editorBody = inReview && reviewMain ? reviewMain : codeEditor;
  const left =
    inReview && review ? (
      <View style={{ flex: 1 }}>
        <View style={{ flex: showWorkspace ? 1 : undefined, maxHeight: showWorkspace ? undefined : "85%" }}>
          <PrFiles theme={theme} review={review} findings={findings} activePath={prPath} onSelect={selectPr} />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowWorkspace(!showWorkspace)}
          style={{ paddingHorizontal: 10, paddingVertical: 6, borderTopWidth: 1, borderColor: theme.colors.border }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{showWorkspace ? "▾" : "▸"} WORKSPACE FILES</Text>
        </Pressable>
        {showWorkspace ? <View style={{ flex: 1 }}>{tree}</View> : null}
      </View>
    ) : (
      tree
    );
  const switcher = (
    <>
      <AgentSwitcher theme={theme} lanes={feed.lanes} selection={feed.selection} selectedId={feed.selectedId} onSelect={feed.select} />
      <LaneNotices theme={theme} lanes={feed.lanes} watchingId={feed.selectedId} onWatch={feed.select} />
    </>
  );
  const bar = (
    <>
      {switcher}
      <ReviewBar theme={theme} mode={mode} review={review} onMode={(m) => feed.setMode(m, lastStartedKey.current)} />
    </>
  );
  // A subagent without a readable transcript shows a simple card instead of the editor/diff.
  const selectedLane = feed.lanes.find((l) => l.id === feed.selectedId);
  const fallback = selectedLane?.fallback ? <FallbackLane theme={theme} lane={selectedLane} /> : null;
  const thinking = <ThinkingStrip theme={theme} store={feed.thoughts} height={thinkingHeight} />;
  const editor = fallback ?? editorBody;
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
          borderColor:
            (id === "files" && area === "files") || (id === "editor" && area === "editor") || (id === "terminal" && area === "terminal")
              ? theme.colors.statusSuccess
              : pane === id
                ? theme.colors.accent
                : "transparent",
        }}
      >
        <Text style={{ color: pane === id ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <AgentFollowers feed={feed} />
      <SubagentFollowers feed={feed} workspaceDir={feed.files.root} />
        {bar}
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: theme.colors.border }}>
          {tab("files", "Files")}
          {tab("editor", inReview ? "Diff" : "Editor")}
          {tab("terminal", `Terminal${player.terminal.length ? ` (${player.terminal.length})` : ""}`)}
          {tab("thinking", "Thinking")}
        </View>
        <View style={{ flex: 1 }}>
          {pane === "files" ? left : pane === "editor" ? editor : pane === "terminal" ? terminal : <ThinkingStrip theme={theme} store={feed.thoughts} fill />}
        </View>
        {controls}
      </View>
    );
  }

  return (
    <PointerContext.Provider value={register}>
    <View ref={rootRef} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <AgentFollowers feed={feed} />
      <SubagentFollowers feed={feed} workspaceDir={feed.files.root} />
      {bar}
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={[{ width: treeWidth, backgroundColor: theme.colors.surface1 }, outline("files")]}>{left}</View>
        <Splitter theme={theme} direction="column" size={treeWidth} min={140} max={560} onResize={setTreeWidth} />
        <View style={[{ flex: 1 }, outline("editor")]}>{editor}</View>
      </View>
      <Splitter theme={theme} direction="row" size={thinkingHeight} min={40} max={320} sign={-1} onResize={setThinkingHeight} />
      {thinking}
      {controls}
      <Splitter theme={theme} direction="row" size={terminalHeight} min={80} max={640} sign={-1} onResize={setTerminalHeight} />
      <View style={[{ height: terminalHeight }, outline("terminal")]}>{terminal}</View>
      <PointerLayer theme={theme} target={target} rootRef={rootRef} registry={registry} />
    </View>
    </PointerContext.Provider>
  );
}
