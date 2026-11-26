/** Lanes: one replay per agent (each Paseo agent and each of its subagents). */

export type LaneInfo = {
  id: string;
  parentId: string | null;
  label: string;
  kind: "agent" | "subagent";
  status: "running" | "done" | "idle" | "failed";
  /** No transcript found: the lane shows a simple card instead of a replay. */
  fallback: boolean;
  task: string | null;
  /** Player clock-independent time (ms) the lane last started playing something. */
  lastStartedAt: number;
  createdAt: number;
};

/** Duplicate labels become "Explore #1", "Explore #2" by creation order. */
export function nameLanes(lanes: LaneInfo[]): LaneInfo[] {
  const counts = new Map<string, number>();
  for (const l of lanes) counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return [...lanes]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((l) => {
      if ((counts.get(l.label) ?? 0) < 2) return l;
      const n = (seen.get(l.label) ?? 0) + 1;
      seen.set(l.label, n);
      return { ...l, label: `${l.label} #${n}` };
    })
    .sort((a, b) => lanes.indexOf(lanes.find((x) => x.id === a.id)!) - lanes.indexOf(lanes.find((x) => x.id === b.id)!));
}

/**
 * Auto: the lane that most recently started something. Ties go to a working lane, then a main
 * agent, then the newest lane. A pin wins if it still exists.
 */
export function pickLane(lanes: LaneInfo[], selection: "auto" | "main" | string): string | null {
  if (selection !== "auto" && selection !== "main" && lanes.some((l) => l.id === selection)) return selection;
  // "main": only main agents are candidates, so a busy subagent never takes over the view.
  if (selection === "main" || (selection !== "auto" && lanes.length > 0)) {
    const mains = lanes.filter((l) => l.parentId === null);
    if (mains.length > 0) lanes = mains;
  }
  const better = (a: LaneInfo, b: LaneInfo): boolean => {
    if (a.lastStartedAt !== b.lastStartedAt) return a.lastStartedAt > b.lastStartedAt;
    const working = (l: LaneInfo) => (l.status === "running" ? 1 : 0);
    if (working(a) !== working(b)) return working(a) > working(b);
    const top = (l: LaneInfo) => (l.parentId === null ? 1 : 0);
    if (top(a) !== top(b)) return top(a) > top(b);
    return a.createdAt > b.createdAt;
  };
  let best: LaneInfo | null = null;
  for (const l of lanes) if (!best || better(l, best)) best = l;
  return best?.id ?? null;
}

/** Parents before their children; siblings by creation. */
export function orderLanes(lanes: LaneInfo[]): LaneInfo[] {
  const byParent = new Map<string | null, LaneInfo[]>();
  const ids = new Set(lanes.map((l) => l.id));
  for (const l of lanes) {
    const parent = l.parentId && ids.has(l.parentId) ? l.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), l]);
  }
  const out: LaneInfo[] = [];
  const visit = (parent: string | null) => {
    for (const l of (byParent.get(parent) ?? []).sort((a, b) => a.createdAt - b.createdAt)) {
      out.push(l);
      visit(l.id);
    }
  };
  visit(null);
  return out;
}

/** How deep a lane is nested (0 for agents). */
export function depthOf(lanes: LaneInfo[], id: string): number {
  let depth = 0;
  let current = lanes.find((l) => l.id === id);
  while (current?.parentId) {
    depth++;
    current = lanes.find((l) => l.id === current!.parentId);
  }
  return depth;
}

/** Plain-words role for the dropdown: who this is and who started it. */
export function laneRole(lanes: LaneInfo[], id: string): { role: "Main agent" | "Subagent" | "Sub-subagent"; startedBy: string | null } {
  const lane = lanes.find((l) => l.id === id);
  if (!lane || lane.kind === "agent" || !lane.parentId) return { role: "Main agent", startedBy: null };
  const parent = lanes.find((l) => l.id === lane.parentId);
  if (!parent || parent.kind === "agent") return { role: "Subagent", startedBy: "Main agent" };
  return { role: "Sub-subagent", startedBy: parent.label };
}

export type LaneNotice = { laneId: string; kind: "started" | "failed"; label: string; task: string | null };

/**
 * What to tell the user about other agents without switching to them: subagents that started after
 * the panel opened (add) and failures (add); a subagent that finishes just has its notice removed
 * (clear). Never announces the lane being watched.
 */
export function laneNotices(
  prev: LaneInfo[],
  next: LaneInfo[],
  watchingId: string | null,
  openedAt: number,
): { add: LaneNotice[]; clear: string[] } {
  const before = new Map(prev.map((l) => [l.id, l]));
  const add: LaneNotice[] = [];
  const clear: string[] = [];
  for (const lane of next) {
    if (lane.kind !== "subagent") continue;
    const was = before.get(lane.id);
    const notice = { laneId: lane.id, label: lane.label, task: lane.task };
    if (!was) {
      if (lane.createdAt > openedAt && lane.id !== watchingId) add.push({ ...notice, kind: "started" });
      continue;
    }
    if (was.status === lane.status) continue;
    if (lane.status === "done") clear.push(lane.id);
    else if (lane.status === "failed" && lane.id !== watchingId) add.push({ ...notice, kind: "failed" });
  }
  return { add, clear };
}
