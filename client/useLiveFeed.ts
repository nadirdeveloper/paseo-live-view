import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useAgent, useAgents, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesChangesRpc, filesListRpc, filesReadRpc, type FilesReadOutput } from "../shared/files";
import { emptyLog, forLog, isInside, pushHistory, toLiveEvent, upsertEvent, type EventLog, type LiveEvent } from "./logic/events";
import { MAX_TYPED_FILES, afterCall, alreadyShown } from "./logic/feedPlan";
import { changeToEvents } from "./logic/fsChanges";
import { readTargets, resolveSpecs } from "./logic/readTargets";
import { buildTree, type TreeNode } from "./logic/fileTree";
import type { Speed } from "./logic/pacing";
import { applyToReview, emptyReview, setMode as setReviewMode, type ReviewEffect, type ReviewState } from "./logic/review/state";
import { nameLanes, orderLanes, pickLane, type LaneInfo } from "./logic/subagents/lanes";
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
/** A subagent whose transcript a SubagentFollower should find and follow. */
export type SubagentRequest = { laneId: string; toolUseId: string; cwd: string; historical: boolean };

/** One replay: each Paseo agent and each subagent has its own. */
type Lane = {
  info: LaneInfo;
  player: PlayerState;
  review: ReviewState;
  thoughts: ThoughtLane;
  /** Keys handed to this lane's player (queued, playing or finished). */
  seen: Set<string>;
  /** Thoughts already shown, by key + text. */
  seenThoughts: Set<string>;
  cwd: string;
};

export type LiveFeed = {
  /** The selected lane's replay. */
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
  /** `lastStartedKey`: the playback that had last started, so the pick lasts until a new one starts. */
  setMode(mode: "code" | "review", lastStartedKey: string | null): void;
  /** Switcher: every lane in display order, the user's selection, and the lane on screen. */
  lanes: LaneInfo[];
  /** "main" (default): the main agent. Never switches to a subagent by itself. */
  selection: "main" | string;
  selectedId: string | null;
  select(selection: "main" | string): void;
  /** Subagents to find and follow (one SubagentFollower each). */
  requests: SubagentRequest[];
  /** Used by AgentFollower. */
  ingest(agent: AgentInfo, entries: TimelineEntry[], mode: "history" | "live"): void;
  /** Used by SubagentFollower. */
  ingestLane(laneId: string, events: LiveEvent[], mode: "history" | "live"): void;
  setLaneStatus(laneId: string, status: LaneInfo["status"]): void;
  markFallback(laneId: string): void;
  resetAgent(agentId: string): void;
};

export type ThoughtStore = { get(): ThoughtLane; subscribe(listener: () => void): () => void };

function newLane(info: LaneInfo, cwd: string, controls: { paused: boolean; speed: Speed }): Lane {
  // New lanes start with the controls the user already set (paused, speed).
  const player = setPlayerSpeed(setPaused(createPlayer(), controls.paused), controls.speed);
  return { info, player, review: emptyReview, thoughts: emptyLane, seen: new Set(), seenThoughts: new Set(), cwd };
}

export function useLiveFeed(workspaceId: string): LiveFeed {
  const workspaceDir = useWorkspace(workspaceId, (w) => w.directory);
  const agents = useAgents({ where: (a) => a.workspaceId === workspaceId && !a.background });
  const listFiles = useRpc(filesListRpc);
  const readRpc = useRpc(filesReadRpc);
  const changesRpc = useRpc(filesChangesRpc);

  const lanesRef = useRef(new Map<string, Lane>());
  const logRef = useRef<EventLog>(emptyLog);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [selection, setSelection] = useState<"main" | string>("main");
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [requests, setRequests] = useState<SubagentRequest[]>([]);
  const controlsRef = useRef<{ paused: boolean; speed: Speed }>({ paused: false, speed: 1 });
  /** Last status each subagent's parent card reported (used when there's no transcript). */
  const cardStatus = useRef(new Map<string, LaneInfo["status"]>());
  const [files, setFiles] = useState<LiveFeed["files"]>({ tree: [], capped: false, root: null });
  const [filesVersion, setFilesVersion] = useState(0);
  const knownPaths = useRef<Set<string>>(new Set());
  /** File text a change check typed in, so the Edit that made it (arriving later) isn't typed again. */
  const shownText = useRef(new Map<string, string>());

  const infos = () => [...lanesRef.current.values()].map((l) => l.info);
  const selectedIdRef = useRef<string | null>(null);
  const currentSelected = () => pickLane(infos(), selectionRef.current);

  const thoughtListeners = useRef(new Set<() => void>()).current;
  const notifyThoughts = useCallback(() => {
    for (const listener of thoughtListeners) listener();
  }, [thoughtListeners]);
  const thoughts = useMemo<ThoughtStore>(
    () => ({
      get: () => lanesRef.current.get(selectedIdRef.current ?? "")?.thoughts ?? emptyLane,
      subscribe: (listener) => {
        thoughtListeners.add(listener);
        return () => thoughtListeners.delete(listener);
      },
    }),
    [thoughtListeners],
  );

  /** Change one lane. Re-renders when the lane on screen visibly changes (ticks) or always (other updates). */
  const updateLane = useCallback(
    (laneId: string, change: (l: Lane) => Lane, fromTick = false) => {
      const previous = lanesRef.current.get(laneId);
      if (!previous) return;
      const next = change(previous);
      if (next === previous) return;
      lanesRef.current.set(laneId, next);
      const onScreen = currentSelected() === laneId;
      if (next.thoughts !== previous.thoughts && onScreen) notifyThoughts();
      const playerChanged = next.player !== previous.player && (!fromTick || visibleChanged(previous.player, next.player));
      if ((onScreen && (playerChanged || next.review !== previous.review)) || next.info !== previous.info) bump();
    },
    [bump, notifyThoughts],
  );
  const updatePlayer = useCallback(
    (laneId: string, change: (s: PlayerState) => PlayerState, fromTick = false) =>
      updateLane(laneId, (l) => {
        const player = change(l.player);
        return player === l.player ? l : { ...l, player };
      }, fromTick),
    [updateLane],
  );

  const ensureLane = useCallback(
    (id: string, info: Omit<LaneInfo, "id" | "lastStartedAt" | "createdAt">, cwd: string, historical = false) => {
      const existing = lanesRef.current.get(id);
      if (existing) {
        if (existing.info.label !== info.label && info.kind === "agent") updateLane(id, (l) => ({ ...l, info: { ...l.info, label: info.label } }));
        return;
      }
      // Lanes from history get small creation numbers (kept in order) so they're never announced as new.
      const createdAt = historical ? lanesRef.current.size : Date.now() + lanesRef.current.size / 1000;
      lanesRef.current.set(id, newLane({ ...info, id, lastStartedAt: 0, createdAt }, cwd, controlsRef.current));
      bump();
    },
    [bump, updateLane],
  );

  // A fresh workspace starts from a clean slate.
  useEffect(() => {
    lanesRef.current = new Map();
    logRef.current = emptyLog;
    shownText.current.clear();
    setRequests([]);
    setSelection("main");
    bump();
    notifyThoughts();
  }, [workspaceId]);

  /** The workspace whose file copies this panel has re-baselined (once per mount and workspace). */
  const baselined = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const rebaseline = baselined.current !== workspaceId;
    baselined.current = workspaceId;
    listFiles({ workspaceId, rebaseline })
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

  // One timer for every lane. A lane that starts something new may become the Auto choice.
  useEffect(() => {
    const id = setInterval(() => {
      let startedSomething = false;
      for (const [laneId, lane] of lanesRef.current) {
        const s = lane.player;
        if (!s.paused && (s.current || s.queue.length > 0)) {
          const before = s.current?.item.event.key ?? null;
          updatePlayer(laneId, (p) => tick(p, TICK_MS), true);
          const after = lanesRef.current.get(laneId)?.player.current?.item.event.key ?? null;
          if (after && after !== before) {
            const l = lanesRef.current.get(laneId)!;
            lanesRef.current.set(laneId, { ...l, info: { ...l.info, lastStartedAt: Date.now() } });
            startedSomething = true;
          }
        }
        const l = lanesRef.current.get(laneId)!;
        const ticked = tickThoughts(l.thoughts, TICK_MS);
        if (ticked !== l.thoughts) updateLane(laneId, (x) => ({ ...x, thoughts: ticked }), true);
      }
      if (startedSomething && selectionRef.current === "main") bump();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [updatePlayer, updateLane, bump]);

  const readFile = useCallback((path: string) => readRpc({ workspaceId, path }), [readRpc, workspaceId]);
  const refreshFiles = useCallback(() => setFilesVersion((v) => v + 1), []);

  /** One reading step per PR file the new diff lines touch (or the whole file at PR head). */
  const planFor = useCallback((review: ReviewState, effect: Extract<ReviewEffect, { kind: "read-diff" | "read-file" }>): ReadPlan => {
    const target = review.reviews.find((r) => r.id === effect.reviewId);
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

  /** A subagent call in any lane gets its own child lane and a follower. */
  const onSubagent = useCallback(
    (parentId: string, ev: Extract<LiveEvent, { kind: "subagent" }>, mode: "history" | "live") => {
      if (!ev.callId) return;
      const parent = lanesRef.current.get(parentId);
      const laneId = `${parentId}:${ev.callId}`;
      const isNew = !lanesRef.current.has(laneId);
      ensureLane(
        laneId,
        { parentId, label: ev.subAgentType ?? "Subagent", kind: "subagent", status: "running", fallback: false, task: ev.description },
        parent?.cwd ?? "",
        mode === "history",
      );
      // Running/done normally comes from the transcript; the parent's card reports failures and
      // is the only status a lane without a transcript (fallback) has.
      const fromCard: LaneInfo["status"] =
        ev.status === "failed" || ev.status === "canceled" ? "failed" : ev.status === "completed" ? "done" : "running";
      cardStatus.current.set(laneId, fromCard);
      if (fromCard === "failed" || lanesRef.current.get(laneId)?.info.fallback) {
        updateLane(laneId, (l) => (l.info.status === fromCard ? l : { ...l, info: { ...l.info, status: fromCard } }));
      }
      if (isNew) setRequests((r) => [...r, { laneId, toolUseId: ev.callId!, cwd: parent?.cwd ?? workspaceDir ?? "", historical: mode === "history" }]);
    },
    [ensureLane, updateLane, workspaceDir],
  );

  /**
   * After a live tool call finishes: replay files it changed (found by the server's watcher), then show
   * what it read in the editor. Changes go first: reading a file refreshes the server's copy of it.
   */
  const followUp = useCallback(
    async (laneId: string, ev: LiveEvent, showReads: boolean) => {
      const lane = lanesRef.current.get(laneId);
      if (!lane || !workspaceDir) return;
      const plan = afterCall(ev);
      const marker = `${ev.key}:after`;
      if ((!plan.checkChanges && !plan.reads) || lane.seen.has(marker)) return;
      lane.seen.add(marker);
      const base = { key: ev.key, agentId: ev.agentId, agentLabel: ev.agentLabel, at: ev.at };
      const play = (next: LiveEvent) => {
        if (lane.seen.has(next.key)) return;
        lane.seen.add(next.key);
        updatePlayer(laneId, (s) => enqueue(s, next));
      };
      if (plan.checkChanges) {
        try {
          const { changes } = await changesRpc({ workspaceId });
          let treeChanged = false;
          let typed = 0;
          for (const change of changes) {
            if (!isInside(change.path, workspaceDir)) continue;
            if (change.after === null ? knownPaths.current.has(change.path) : !knownPaths.current.has(change.path)) treeChanged = true;
            if (change.after === null || typed >= MAX_TYPED_FILES) continue;
            typed++;
            shownText.current.set(change.path, change.after);
            for (const next of changeToEvents(change, base)) play(next);
            // Diffing can take a moment on big files; let the panel draw between files.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (treeChanged) refreshFiles();
        } catch (error) {
          console.error("[live-view] files.changes failed", error);
        }
      }
      if (plan.reads && showReads) {
        const { reads, glance } = readTargets(ev, lane.cwd || workspaceDir);
        for (const target of reads) {
          if (!isInside(target.path, workspaceDir)) continue;
          try {
            const result = await readRpc({ workspaceId, path: target.path });
            if (result.status !== "ok") continue;
            const ranges = resolveSpecs(target.specs, result.text);
            if (ranges.length === 0) continue;
            play({ ...base, key: `${ev.key}:view:${target.path}`, status: "completed", kind: "view", filePath: target.path, text: result.text, ranges });
          } catch (error) {
            console.error("[live-view] files.read failed", error);
          }
        }
        const paths = glance.filter((p) => isInside(p, workspaceDir));
        if (paths.length > 0) play({ ...base, key: `${ev.key}:glance`, status: "completed", kind: "glance", paths });
      }
    },
    [workspaceId, workspaceDir, readRpc, changesRpc, refreshFiles, updatePlayer],
  );

  /** The heart of ingestion: one lane's events, from history (instant) or live (animated). */
  const processEvents = useCallback(
    (laneId: string, events: LiveEvent[], mode: "history" | "live") => {
      const lane = () => lanesRef.current.get(laneId)!;
      if (!lanesRef.current.has(laneId)) return;
      const history: LiveEvent[] = [];
      for (const ev of events) {
        if (ev.kind === "thought") {
          // Pieces of a message can repeat a key, so dedupe on key + text instead of the log.
          const id = `${ev.key}|${ev.text}`;
          if (lane().seenThoughts.has(id)) continue;
          lane().seenThoughts.add(id);
          updateLane(laneId, (l) => ({
            ...l,
            review: applyToReview(l.review, ev).state,
            thoughts: addThought(l.thoughts, ev, { instant: mode === "history" }),
            // Fresh thinking counts as activity, so Auto comes back to an agent that's thinking.
            info: mode === "live" ? { ...l.info, lastStartedAt: Date.now() } : l.info,
          }));
          continue;
        }
        // The log only needs a small copy for dedupe; review mode gets the full event below.
        const { log, change } = upsertEvent(logRef.current, forLog(ev));
        logRef.current = log;
        if (change === "none") continue;
        if (ev.kind === "subagent") onSubagent(laneId, ev, mode);

        // Review mode sees every event; only live ones animate.
        const reviewed = applyToReview(lane().review, ev);
        updateLane(laneId, (l) => ({ ...l, review: reviewed.state, thoughts: interrupt(l.thoughts, ev.agentId) }));
        // A read review mode already plays (a saved diff, a file at PR head) isn't shown again in Code.
        let reviewRead = false;
        if (mode === "live") {
          for (const effect of reviewed.effects) {
            if (effect.kind === "switch") continue;
            reviewRead = true;
            const plan = planFor(reviewed.state, effect);
            chainRef.current = chainRef.current.then(() => updatePlayer(laneId, (s) => enqueueRead(s, effect, plan)));
          }
        }
        if (ev.kind === "read") {
          // The read itself has nothing to type; Code mode shows it as a view once it finishes.
          if (mode === "live" && !reviewRead) {
            chainRef.current = chainRef.current
              .then(() => followUp(laneId, ev, true))
              .catch((error) => console.error("[live-view] ingest failed", error));
          }
          continue;
        }
        if (mode === "history") {
          if (history.some((h) => h.key === ev.key)) {
            // A later copy in the same batch (e.g. the call, then the call with its result).
            history.splice(0, history.length, ...pushHistory(history, ev));
          } else if (!lane().seen.has(ev.key)) {
            lane().seen.add(ev.key);
            history.push(ev);
          } else updatePlayer(laneId, (s) => applyUpdate(s, ev));
          continue;
        }

        // A command can start before its text arrives; wait for the update that carries it.
        if (ev.kind === "shell" && !ev.command && ev.status === "running") continue;
        const isFile = ev.kind === "edit" || ev.kind === "write";
        if (isFile && ev.inWorkspace && !knownPaths.current.has(ev.filePath)) refreshFiles();

        const playEvent = async () => {
          // Checked here, in order, so a quick running→completed pair isn't queued twice.
          if (lane().seen.has(ev.key)) {
            updatePlayer(laneId, (s) => applyUpdate(s, ev));
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
            lane().seen.add(ev.key);
            const played = { ...ev, afterText };
            // Already typed in from another command's change check: don't type it twice.
            if (alreadyShown(shownText.current, played)) return;
            updatePlayer(laneId, (s) => enqueue(s, played));
            return;
          }
          lane().seen.add(ev.key);
          updatePlayer(laneId, (s) => enqueue(s, ev));
        };
        chainRef.current = chainRef.current
          .then(async () => {
            await playEvent();
            await followUp(laneId, ev, !reviewRead);
          })
          .catch((error) => console.error("[live-view] ingest failed", error));
      }
      if (history.length > 0) updatePlayer(laneId, (s) => seedHistory(s, history));
    },
    [workspaceId, readRpc, refreshFiles, updateLane, updatePlayer, planFor, onSubagent, followUp],
  );

  const ingest = useCallback(
    (agent: AgentInfo, entries: TimelineEntry[], mode: "history" | "live") => {
      if (!workspaceDir) return;
      ensureLane(agent.id, { parentId: null, label: agent.label, kind: "agent", status: "running", fallback: false, task: null }, agent.cwd, mode === "history");
      const events: LiveEvent[] = [];
      for (const entry of entries) {
        const ev = toLiveEvent(entry.item, {
          agentId: agent.id,
          agentLabel: agent.label,
          agentCwd: agent.cwd,
          workspaceDir,
          at: entry.timestamp ?? new Date().toISOString(),
          seq: entry.seq,
        });
        if (ev) events.push(ev);
      }
      processEvents(agent.id, events, mode);
    },
    [workspaceDir, ensureLane, processEvents],
  );

  const ingestLane = useCallback(
    (laneId: string, events: LiveEvent[], mode: "history" | "live") => processEvents(laneId, events, mode),
    [processEvents],
  );
  const setLaneStatus = useCallback(
    (laneId: string, status: LaneInfo["status"]) => {
      updateLane(laneId, (l) => (l.info.status === status || l.info.status === "failed" ? l : { ...l, info: { ...l.info, status } }));
      // A subagent that finishes hands Auto back to the agent that started it.
      const parentId = lanesRef.current.get(laneId)?.info.parentId;
      if (status === "done" && parentId) updateLane(parentId, (l) => ({ ...l, info: { ...l.info, lastStartedAt: Date.now() } }));
    },
    [updateLane],
  );
  const markFallback = useCallback(
    (laneId: string) =>
      updateLane(laneId, (l) =>
        l.info.fallback ? l : { ...l, info: { ...l.info, fallback: true, status: cardStatus.current.get(laneId) ?? l.info.status } },
      ),
    [updateLane],
  );

  const resetAgent = useCallback((agentId: string) => {
    const byKey = new Map(logRef.current.byKey);
    for (const key of logRef.current.order) if (key.startsWith(`${agentId}:`)) byKey.delete(key);
    logRef.current = { byKey, order: logRef.current.order.filter((k) => byKey.has(k)) };
  }, []);

  // The lane on screen (Auto or pinned). When it changes, the thinking strip follows.
  const lanes = useMemo(() => orderLanes(nameLanes(infos())), [version]);
  const selectedId = pickLane(lanes, selection);
  if (selectedIdRef.current !== selectedId) {
    selectedIdRef.current = selectedId;
    queueMicrotask(notifyThoughts);
  }
  const selected = selectedId ? lanesRef.current.get(selectedId) : undefined;
  const player = selected?.player ?? EMPTY_PLAYER;
  const review = selected?.review ?? emptyReview;

  const forAll = useCallback(
    (change: (s: PlayerState) => PlayerState) => {
      for (const id of lanesRef.current.keys()) updatePlayer(id, change);
    },
    [updatePlayer],
  );

  return useMemo(
    () => ({
      player,
      files,
      agents,
      readFile,
      refreshFiles,
      pause: () => {
        controlsRef.current = { ...controlsRef.current, paused: true };
        forAll((s) => setPaused(s, true));
      },
      play: () => {
        controlsRef.current = { ...controlsRef.current, paused: false };
        forAll((s) => setPaused(s, false));
      },
      setSpeed: (speed: Speed) => {
        controlsRef.current = { ...controlsRef.current, speed };
        forAll((s) => setPlayerSpeed(s, speed));
      },
      skipToLive: () => forAll(skipPlayer),
      review,
      thoughts,
      setMode: (mode: "code" | "review", lastStartedKey: string | null) => {
        if (selectedId) updateLane(selectedId, (l) => ({ ...l, review: setReviewMode(l.review, mode, lastStartedKey) }));
      },
      lanes,
      selection,
      selectedId,
      select: setSelection,
      requests,
      ingest,
      ingestLane,
      setLaneStatus,
      markFallback,
      resetAgent,
    }),
    [player, files, agents, readFile, refreshFiles, forAll, review, thoughts, updateLane, lanes, selection, selectedId, requests, ingest, ingestLane, setLaneStatus, markFallback, resetAgent],
  );
}

const EMPTY_PLAYER = createPlayer();

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
