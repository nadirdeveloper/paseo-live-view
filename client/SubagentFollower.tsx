import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { subagentsLocateRpc, subagentsTailSubscription } from "../shared/subagents";
import { entryToEvents } from "./logic/subagents/mapper";
import type { LiveFeed, SubagentRequest } from "./useLiveFeed";

const LOCATE_TRIES = 3;
const LOCATE_GAP_MS = 2000;

type Props = { request: SubagentRequest; feed: LiveFeed; workspaceDir: string };

/** Streams one located transcript into its lane. Renders nothing. */
function SubagentTail({ request, feed, workspaceDir, path }: Props & { path: string }) {
  const feedRef = useRef(feed);
  feedRef.current = feed;
  // A subagent found while loading history replays its existing steps instantly; later ones animate.
  const firstBatch = useRef(true);
  const input = useMemo(() => ({ path }), [path]);
  useSubscription(subagentsTailSubscription, input, (event) => {
    const current = feedRef.current;
    if (event.type === "status") {
      current.setLaneStatus(request.laneId, event.status);
      return;
    }
    const label = current.lanes.find((l) => l.id === request.laneId)?.label ?? "Subagent";
    const events = event.entries.flatMap((entry) =>
      entryToEvents(entry, { laneId: request.laneId, agentLabel: label, agentCwd: request.cwd, workspaceDir }),
    );
    const mode = request.historical && firstBatch.current ? "history" : "live";
    firstBatch.current = false;
    current.ingestLane(request.laneId, events, mode);
  });
  return null;
}

/** Finds a subagent's transcript (a few tries), then follows it; otherwise marks its lane as fallback. */
export function SubagentFollower({ request, feed, workspaceDir }: Props) {
  const locateRpc = useRpc(subagentsLocateRpc);
  const [path, setPath] = useState<string | null>(null);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async (left: number) => {
      try {
        const result = await locateRpc({ toolUseId: request.toolUseId, cwd: request.cwd });
        if (cancelled) return;
        if (result.found && result.path) {
          setPath(result.path);
          return;
        }
      } catch (error) {
        console.error("[live-view] subagents.locate failed", error);
      }
      if (cancelled) return;
      if (left > 1) timer = setTimeout(() => void attempt(left - 1), LOCATE_GAP_MS);
      else feedRef.current.markFallback(request.laneId);
    };
    void attempt(LOCATE_TRIES);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [locateRpc, request.toolUseId, request.cwd, request.laneId]);

  return path ? <SubagentTail request={request} feed={feed} workspaceDir={workspaceDir} path={path} /> : null;
}

export function SubagentFollowers({ feed, workspaceDir }: { feed: LiveFeed; workspaceDir: string | null }) {
  if (!workspaceDir) return null;
  return (
    <>
      {feed.requests.map((request) => (
        <SubagentFollower key={request.laneId} request={request} feed={feed} workspaceDir={workspaceDir} />
      ))}
    </>
  );
}
