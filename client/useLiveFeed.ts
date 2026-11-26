import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useAgent, useAgents, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesListRpc, filesReadRpc, type FilesReadOutput } from "../shared/files";
import { emptyLog, forLog, toLiveEvent, upsertEvent, type EventLog, type LiveEvent } from "./logic/events";
import { buildTree, type TreeNode } from "./logic/fileTree";
import type { Speed } from "./logic/pacing";
import { applyToReview, emptyReview, setMode as setReviewMode, type ReviewEffect, type ReviewState } from "./logic/review/state";
import { addThought, emptyLane, interrupt, tickThoughts, type ThoughtLane } from "./logic/thoughts";
import {
  applyUpdate,
  createPlayer,
  enqueue,
  enqueueRead,
  type ReadPlan,
  seedHistory,
  setPaused,
  setSpeed as setPlayerSpeed,
  skipToLive as skipPlayer,
  tick,
  visibleChanged,
  type PlayerState,
} from "./logic/player";

/** The SDK does not export AgentRef from a public entry, so derive it from useAgent. */
export type AgentRef = Exclude<Parameters<typeof useAgent>[0], string>;

const TICK_MS = 50;
const HISTORY_LIMIT = 200;

export type AgentInfo = { id: string; label: string; cwd: string };
export type TimelineEntry = { item: AgentTimelineItem; timestamp?: string; seq?: number };

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
  review: ReviewState;
  /** The thinking strip reads this on its own, so its typing doesn't re-render the whole panel. */
  thoughts: ThoughtStore;
  setMode(mode: "code" | "review"): void;
  /** Used by AgentFollower. */
  ingest(agent: AgentInfo, entries: TimelineEntry[], mode: "history" | "live"): void;
  resetAgent(agentId: string): void;
};

export type ThoughtStore = { get(): ThoughtLane; subscribe(listener: () => void): () => void };

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
  /** Keys of every event handed to the player (queued, playing or finished). */
  const seenRef = useRef<Set<string>>(new Set());
  const reviewRef = useRef<ReviewState>(emptyReview);
  const [review, setReview] = useState<ReviewState>(emptyReview);
  const laneRef = useRef<ThoughtLane>(emptyLane);
  const laneListeners = useRef(new Set<() => void>()).current;
  const thoughts = useMemo<ThoughtStore>(
    () => ({
      get: () => laneRef.current,
      subscribe: (listener) => {
        laneListeners.add(listener);
        return () => laneListeners.delete(listener);
      },
    }),
    [laneListeners],
  );
  /** Thoughts already shown, by key + text (they stay out of the event log). */
  const seenThoughts = useRef(new Set<string>());

  const updateReview = useCallback((next: ReviewState) => {
    if (next === reviewRef.current) return;
    reviewRef.current = next;
    setReview(next);
  }, []);
  const updateLane = useCallback((next: ThoughtLane) => {
    if (next === laneRef.current) return;
    laneRef.current = next;
    for (const listener of laneListeners) listener();
  }, [laneListeners]);

  /** Ticks only re-render when something on screen changes; other updates always do. */
  const update = useCallback((change: (s: PlayerState) => PlayerState, fromTick = false) => {
    const previous = playerRef.current;
    const next = change(previous);
    if (next === previous) return;
    playerRef.current = next;
    if (!fromTick || visibleChanged(previous, next)) setPlayer(next);
  }, []);

  // A fresh workspace starts from a clean slate.
  useEffect(() => {
    playerRef.current = createPlayer();
    logRef.current = emptyLog;
    seenRef.current = new Set();
    seenThoughts.current = new Set();
    setPlayer(playerRef.current);
    updateReview(emptyReview);
    updateLane(emptyLane);
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
      if (!s.paused && (s.current || s.queue.length > 0)) update((p) => tick(p, TICK_MS), true);
      updateLane(tickThoughts(laneRef.current, TICK_MS));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [update, updateLane]);

  const readFile = useCallback((path: string) => readRpc({ workspaceId, path }), [readRpc, workspaceId]);
  const refreshFiles = useCallback(() => setFilesVersion((v) => v + 1), []);

  const inPlayer = useCallback((key: string) => seenRef.current.has(key), []);

  /** One reading step per PR file the new diff lines touch (or the whole file at PR head). */
  const planFor = useCallback((effect: Extract<ReviewEffect, { kind: "read-diff" | "read-file" }>): ReadPlan => {
    const target = reviewRef.current.reviews.find((r) => r.id === effect.reviewId);
    if (!target) return { steps: [] };
    if (effect.kind === "read-file") {
      const text = target.headFiles.get(effect.path) ?? "";
      return { steps: [{ path: effect.path, from: 1, to: Math.max(1, text.split("\n").length) }] };
    }
    const steps: ReadPlan["steps"] = [];
    target.files.forEach((file, i) => {
      const end = target.files[i + 1] ? target.files[i + 1].at - 1 : Math.max(file.endAt, target.doc.lines.length);
      const from = Math.max(file.at, effect.from);
      const to = Math.min(end, effect.to);
      if (from <= to) steps.push({ path: file.path, from, to });
    });
    if (steps.length === 0) steps.push({ path: target.files[0]?.path ?? target.label, from: effect.from, to: effect.to });
    return { steps };
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
          seq: entry.seq,
        });
        if (!ev) continue;
        if (ev.kind === "thought") {
          // Pieces of a message can repeat a key, so dedupe on key + text instead of the log.
          const id = `${ev.key}|${ev.text}`;
          if (seenThoughts.current.has(id)) continue;
          seenThoughts.current.add(id);
          updateReview(applyToReview(reviewRef.current, ev).state);
          updateLane(addThought(laneRef.current, ev, { instant: mode === "history" }));
          continue;
        }
        // The log only needs a small copy for dedupe; review mode gets the full event below.
        const { log, change } = upsertEvent(logRef.current, forLog(ev));
        logRef.current = log;
        if (change === "none") continue;

        // Review mode sees every event; only live ones animate.
        const reviewed = applyToReview(reviewRef.current, ev);
        updateReview(reviewed.state);
        updateLane(interrupt(laneRef.current, ev.agentId));
        if (mode === "live") {
          for (const effect of reviewed.effects) {
            if (effect.kind === "switch") continue;
            const plan = planFor(effect);
            chainRef.current = chainRef.current.then(() => update((s) => enqueueRead(s, effect, plan)));
          }
        }
        if (ev.kind === "read") continue;
        if (mode === "history") {
          if (!inPlayer(ev.key) && !history.some((h) => h.key === ev.key)) {
            seenRef.current.add(ev.key);
            history.push(ev);
          }
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
              seenRef.current.add(ev.key);
              update((s) => enqueue(s, { ...ev, afterText }));
              return;
            }
            seenRef.current.add(ev.key);
            update((s) => enqueue(s, ev));
          })
          .catch((error) => console.error("[live-view] ingest failed", error));
      }
      if (history.length > 0) update((s) => seedHistory(s, history));
    },
    [workspaceDir, workspaceId, readRpc, refreshFiles, update, inPlayer, updateReview, updateLane, planFor],
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
      review,
      thoughts,
      setMode: (mode: "code" | "review") => updateReview(setReviewMode(reviewRef.current, mode)),
      ingest,
      resetAgent,
    }),
    [player, files, agents, readFile, refreshFiles, update, ingest, resetAgent, review, thoughts, updateReview],
  );
}

/** Follows one agent's timeline and feeds it into the Live View feed. Renders nothing. */
export function AgentFollower({ agentRef, feed }: { agentRef: AgentRef; feed: LiveFeed }) {
  const paseo = usePaseo();
  const id = useAgent(agentRef, (a) => a.id);
  const cwd = useAgent(agentRef, (a) => a.cwd);
  const label = useAgent(agentRef, (a) => a.title ?? a.provider);
  // The title changes early in an agent's life; reading it through a ref keeps that from
  // tearing down the subscription and reloading history (which would skip animations).
  const labelRef = useRef(label);
  labelRef.current = label;
  const [retry, setRetry] = useState(0);
  const attemptsRef = useRef(0);
  const ingestRef = useRef(feed.ingest);
  ingestRef.current = feed.ingest;
  const resetRef = useRef(feed.resetAgent);
  resetRef.current = feed.resetAgent;

  useEffect(() => {
    if (!id || !cwd) return;
    const agent: AgentInfo = {
      id,
      cwd,
      get label() {
        return labelRef.current ?? "agent";
      },
    };
    const handle = paseo.agents.ref(id);
    let cancelled = false;

    const loadTail = async (mode: "history" | "live") => {
      try {
        const page = await handle.timeline.refetch({ direction: "tail", limit: HISTORY_LIMIT });
        if (cancelled) return;
        ingestRef.current(agent, page.entries.map((e) => ({ item: e.item, timestamp: e.timestamp, seq: e.seqStart })), mode);
      } catch (error) {
        console.error("[live-view] timeline refetch failed", error);
      }
    };

    // After a reconnect, anything missed is new activity; on first open it's history.
    void loadTail(retry > 0 ? "live" : "history");
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = handle.timeline.subscribe((message) => {
      const event = message.event;
      if (event.type === "timeline") {
        attemptsRef.current = 0;
        // Stream messages carry the timeline position, matching history's seqStart (for dedupe).
        const meta = message as { timestamp?: string; seq?: number };
        ingestRef.current(agent, [{ item: event.item, timestamp: meta.timestamp, seq: meta.seq }], "live");
      } else if (event.type === "subscription_restored") {
        void loadTail("live");
      } else if (event.type === "replacement") {
        resetRef.current(id);
        void loadTail("history");
      } else if (event.type === "error") {
        // The SDK releases the subscription after an error: follow again, backing off up to 30 s.
        console.error("[live-view] timeline error, reconnecting", event.error);
        const delay = Math.min(30000, 1000 * 2 ** attemptsRef.current);
        attemptsRef.current += 1;
        retryTimer = setTimeout(() => {
          if (!cancelled) setRetry((r) => r + 1);
        }, delay);
      }
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [paseo, id, cwd, retry]);

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
