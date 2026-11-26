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

/** Auto: the lane that most recently started something (newest lane on a tie). A pin wins if it still exists. */
export function pickLane(lanes: LaneInfo[], selection: "auto" | string): string | null {
  if (selection !== "auto" && lanes.some((l) => l.id === selection)) return selection;
  let best: LaneInfo | null = null;
  for (const l of lanes) {
    if (!best || l.lastStartedAt > best.lastStartedAt || (l.lastStartedAt === best.lastStartedAt && l.createdAt > best.createdAt)) best = l;
  }
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
