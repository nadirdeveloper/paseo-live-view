import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useAgent, useAgents, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesListRpc, filesReadRpc, type FilesReadOutput } from "../shared/files";
import { emptyLog, toLiveEvent, upsertEvent, type EventLog, type LiveEvent } from "./logic/events";
import { buildTree, type TreeNode } from "./logic/fileTree";
import type { Speed } from "./logic/pacing";
import {
  applyUpdate,
  createPlayer,
  enqueue,
  seedHistory,
  setPaused,
  setSpeed as setPlayerSpeed,
  skipToLive as skipPlayer,
  tick,
  type PlayerState,
} from "./logic/player";

/** The SDK does not export AgentRef from a public entry, so derive it from useAgent. */
export type AgentRef = Exclude<Parameters<typeof useAgent>[0], string>;

const TICK_MS = 50;
const HISTORY_LIMIT = 200;

export type AgentInfo = { id: string; label: string; cwd: string };
export type TimelineEntry = { item: AgentTimelineItem; timestamp?: string };

export type LiveFeed = {
  player: PlayerState;
  files: { tree: TreeNode[]; capped: boolean; root: string | null };
  agents: readonly AgentRef[];
  readFile(path: string): Promise<FilesReadOutput>;
  refreshFiles(): void;
  pause(): void;
  play(): void;
  setSpeed(speed: Speed): void;
  skipToLive(): void;
  /** Used by AgentFollower. */
  ingest(agent: AgentInfo, entries: TimelineEntry[], mode: "history" | "live"): void;
  resetAgent(agentId: string): void;
};

export function useLiveFeed(workspaceId: string): LiveFeed {
  const workspaceDir = useWorkspace(workspaceId, (w) => w.directory);
  const agents = useAgents({ where: (a) => a.workspaceId === workspaceId && !a.background });
  const listFiles = useRpc(filesListRpc);
  const readRpc = useRpc(filesReadRpc);

  const playerRef = useRef<PlayerState>(createPlayer());
  const logRef = useRef<EventLog>(emptyLog);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [player, setPlayer] = useState<PlayerState>(playerRef.current);
  const [files, setFiles] = useState<LiveFeed["files"]>({ tree: [], capped: false, root: null });
  const [filesVersion, setFilesVersion] = useState(0);
  const knownPaths = useRef<Set<string>>(new Set());

  const update = useCallback((change: (s: PlayerState) => PlayerState) => {
    const next = change(playerRef.current);
    if (next !== playerRef.current) {
      playerRef.current = next;
      setPlayer(next);
    }
  }, []);

  // A fresh workspace starts from a clean slate.
  useEffect(() => {
    playerRef.current = createPlayer();
    logRef.current = emptyLog;
    setPlayer(playerRef.current);
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    listFiles({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        knownPaths.current = new Set(result.paths.map((p) => `${result.root}/${p}`));
        setFiles({ tree: buildTree(result.paths, result.root), capped: result.capped, root: result.root });
      })
      .catch((error) => console.error("[live-view] files.list failed", error));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filesVersion, listFiles]);

  useEffect(() => {
    const id = setInterval(() => {
      const s = playerRef.current;
      if (!s.paused && (s.current || s.queue.length > 0)) update((p) => tick(p, TICK_MS));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [update]);

  const readFile = useCallback((path: string) => readRpc({ workspaceId, path }), [readRpc, workspaceId]);
  const refreshFiles = useCallback(() => setFilesVersion((v) => v + 1), []);

  const inPlayer = useCallback((key: string) => {
    const s = playerRef.current;
    return s.current?.item.event.key === key || s.queue.some((q) => q.event.key === key) || s.done.some((d) => d.key === key);
  }, []);

  const ingest = useCallback(
    (agent: AgentInfo, entries: TimelineEntry[], mode: "history" | "live") => {
      if (!workspaceDir) return;
      const history: LiveEvent[] = [];
      for (const entry of entries) {
        const ev = toLiveEvent(entry.item, {
          agentId: agent.id,
          agentLabel: agent.label,
          agentCwd: agent.cwd,
          workspaceDir,
          at: entry.timestamp ?? new Date().toISOString(),
        });
        if (!ev) continue;
        const { log, change } = upsertEvent(logRef.current, ev);
        logRef.current = log;
        if (change === "none") continue;
        if (mode === "history") {
          if (!inPlayer(ev.key) && !history.some((h) => h.key === ev.key)) history.push(ev);
          else update((s) => applyUpdate(s, ev));
          continue;
        }

        const isFile = ev.kind === "edit" || ev.kind === "write";
        if (isFile && ev.inWorkspace && !knownPaths.current.has(ev.filePath)) refreshFiles();

        chainRef.current = chainRef.current
          .then(async () => {
            // Checked here, in order, so a quick running→completed pair isn't queued twice.
            if (inPlayer(ev.key)) {
              update((s) => applyUpdate(s, ev));
              return;
            }
            // Edits and writes play once finished, with the file as it is right after them.
            if (isFile && ev.status === "running") return;
            if (isFile && ev.status === "completed") {
              let afterText: string | null = null;
              if (ev.inWorkspace) {
                try {
                  const result = await readRpc({ workspaceId, path: ev.filePath });
                  afterText = result.status === "ok" ? result.text : null;
                } catch (error) {
                  console.error("[live-view] files.read failed", error);
                }
              }
              update((s) => enqueue(s, { ...ev, afterText }));
              return;
            }
            update((s) => enqueue(s, ev));
          })
          .catch((error) => console.error("[live-view] ingest failed", error));
      }
      if (history.length > 0) update((s) => seedHistory(s, history));
    },
    [workspaceDir, workspaceId, readRpc, refreshFiles, update, inPlayer],
  );

  const resetAgent = useCallback((agentId: string) => {
    const byKey = new Map(logRef.current.byKey);
    for (const key of logRef.current.order) if (key.startsWith(`${agentId}:`)) byKey.delete(key);
    logRef.current = { byKey, order: logRef.current.order.filter((k) => byKey.has(k)) };
  }, []);

  return useMemo(
    () => ({
      player,
      files,
      agents,
      readFile,
      refreshFiles,
      pause: () => update((s) => setPaused(s, true)),
      play: () => update((s) => setPaused(s, false)),
      setSpeed: (speed: Speed) => update((s) => setPlayerSpeed(s, speed)),
      skipToLive: () => update(skipPlayer),
      ingest,
      resetAgent,
    }),
    [player, files, agents, readFile, refreshFiles, update, ingest, resetAgent],
  );
}

/** Follows one agent's timeline and feeds it into the Live View feed. Renders nothing. */
export function AgentFollower({ agentRef, feed }: { agentRef: AgentRef; feed: LiveFeed }) {
  const paseo = usePaseo();
  const id = useAgent(agentRef, (a) => a.id);
  const cwd = useAgent(agentRef, (a) => a.cwd);
  const label = useAgent(agentRef, (a) => a.title ?? a.provider);
  const ingestRef = useRef(feed.ingest);
  ingestRef.current = feed.ingest;
  const resetRef = useRef(feed.resetAgent);
  resetRef.current = feed.resetAgent;

  useEffect(() => {
    if (!id || !cwd) return;
    const agent: AgentInfo = { id, cwd, label: label ?? "agent" };
    const handle = paseo.agents.ref(id);
    let cancelled = false;

    const loadTail = async (mode: "history" | "live") => {
      try {
        const page = await handle.timeline.refetch({ direction: "tail", limit: HISTORY_LIMIT });
        if (cancelled) return;
        ingestRef.current(agent, page.entries.map((e) => ({ item: e.item, timestamp: e.timestamp })), mode);
      } catch (error) {
        console.error("[live-view] timeline refetch failed", error);
      }
    };

    void loadTail("history");
    const unsubscribe = handle.timeline.subscribe((message) => {
      const event = message.event;
      if (event.type === "timeline") {
        ingestRef.current(agent, [{ item: event.item }], "live");
      } else if (event.type === "subscription_restored") {
        void loadTail("live");
      } else if (event.type === "replacement") {
        resetRef.current(id);
        void loadTail("history");
      } else if (event.type === "error") {
        console.error("[live-view] timeline error", event.error);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [paseo, id, cwd, label]);

  return null;
}

/** Renders one follower per agent in the workspace. */
export function AgentFollowers({ feed }: { feed: LiveFeed }) {
  return createElement(
    Fragment,
    null,
    feed.agents.map((ref) => createElement(AgentFollower, { key: ref.key, agentRef: ref, feed })),
  );
}
