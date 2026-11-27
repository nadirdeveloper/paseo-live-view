import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { detectReviewCommand } from "./review/commands";

export type EventStatus = "running" | "completed" | "failed" | "canceled";

type EventBase = {
  key: string;
  agentId: string;
  agentLabel: string;
  at: string;
  status: EventStatus;
};

export type EditEvent = EventBase & {
  kind: "edit";
  filePath: string;
  inWorkspace: boolean;
  oldString?: string;
  newString?: string;
  unifiedDiff?: string;
  afterText?: string | null;
};

export type WriteEvent = EventBase & {
  kind: "write";
  filePath: string;
  inWorkspace: boolean;
  content?: string;
  afterText?: string | null;
};

export type ShellEvent = EventBase & {
  kind: "shell";
  command: string;
  output?: string;
  /** Untrimmed output (≤ 2 MB), kept only for review commands. */
  rawOutput?: string;
  hiddenLines: number;
  exitCode?: number | null;
};

/** A file the agent read with its Read tool (used by review mode for saved diffs). */
export type ReadEvent = EventBase & {
  kind: "read";
  filePath: string;
  content: string;
  offset: number | null;
  limit: number | null;
};

/** Something the agent thought (reasoning) or said (message). */
export type ThoughtEvent = EventBase & { kind: "thought"; source: "reasoning" | "message"; text: string };

export type SubagentEvent = EventBase & {
  kind: "subagent";
  description: string;
  actions: string[];
  /** The tool call that started it (matches the subagent's transcript meta `toolUseId`). */
  callId?: string;
  subAgentType?: string;
};

/** A Grep / Glob / search tool call. */
export type SearchEvent = EventBase & {
  kind: "search";
  toolName: "grep" | "glob" | "search" | "web_search";
  query: string;
  content?: string;
  /** Absolute paths of matched files, when the tool lists them. */
  filePaths: string[];
  mode?: "content" | "files_with_matches" | "count";
};

/** Any other tool (NotebookEdit, MCP tools…): nothing to show itself, but it may have changed files. */
export type OtherToolEvent = EventBase & { kind: "other"; name: string; input: Record<string, unknown> };

/** A file the agent read, shown in the code editor (made by the feed from reads, commands and searches). */
export type ViewEvent = EventBase & { kind: "view"; filePath: string; text: string; ranges: { from: number; to: number }[] };

/** Files a search listed, pulsed in the file tree (made by the feed). */
export type GlanceEvent = EventBase & { kind: "glance"; paths: string[] };

export type LiveEvent =
  | EditEvent
  | WriteEvent
  | ShellEvent
  | SubagentEvent
  | ReadEvent
  | ThoughtEvent
  | SearchEvent
  | OtherToolEvent
  | ViewEvent
  | GlanceEvent;

export type EventContext = {
  agentId: string;
  agentLabel: string;
  agentCwd: string;
  workspaceDir: string;
  at: string;
  /** Position in the agent's timeline, for items that have no id of their own. */
  seq?: number;
};

export type EventLog = { byKey: ReadonlyMap<string, LiveEvent>; order: readonly string[] };

export const emptyLog: EventLog = { byKey: new Map(), order: [] };

export const MAX_OUTPUT_LINES = 200;
export const MAX_OUTPUT_CHARS = 20000;
export const MAX_RAW_OUTPUT = 2 * 1024 * 1024;

/** Collapse `.` and `..` in an absolute POSIX path. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export function absolutePath(filePath: string, cwd: string): string {
  return normalize(filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`);
}

export function isInside(path: string, dir: string): boolean {
  const root = normalize(dir);
  return path === root || path.startsWith(root === "/" ? "/" : root + "/");
}

export function trimOutput(
  output: string,
  maxLines = MAX_OUTPUT_LINES,
  maxChars = MAX_OUTPUT_CHARS,
): { text: string; hiddenLines: number } {
  const lines = output.split("\n");
  const hiddenLines = Math.max(0, lines.length - maxLines);
  let text = hiddenLines > 0 ? lines.slice(hiddenLines).join("\n") : output;
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { text, hiddenLines };
}

export function toLiveEvent(item: AgentTimelineItem, ctx: EventContext): LiveEvent | null {
  const position = ctx.seq ?? ctx.at;
  if (item.type === "reasoning" || item.type === "assistant_message") {
    const isMessage = item.type === "assistant_message";
    const id = isMessage && item.messageId ? item.messageId : String(position);
    return {
      key: `${ctx.agentId}:${isMessage ? "msg" : "thought"}:${id}`,
      agentId: ctx.agentId,
      agentLabel: ctx.agentLabel,
      at: ctx.at,
      status: "completed",
      kind: "thought",
      source: isMessage ? "message" : "reasoning",
      text: item.text,
    };
  }
  if (item.type !== "tool_call") return null;
  const base: EventBase = {
    key: `${ctx.agentId}:${item.callId}`,
    agentId: ctx.agentId,
    agentLabel: ctx.agentLabel,
    at: ctx.at,
    status: item.status,
  };
  const detail = item.detail;
  switch (detail.type) {
    case "edit": {
      const filePath = absolutePath(detail.filePath, ctx.agentCwd);
      return {
        ...base,
        kind: "edit",
        filePath,
        inWorkspace: isInside(filePath, ctx.workspaceDir),
        oldString: detail.oldString,
        newString: detail.newString,
        unifiedDiff: detail.unifiedDiff,
      };
    }
    case "write": {
      const filePath = absolutePath(detail.filePath, ctx.agentCwd);
      return {
        ...base,
        kind: "write",
        filePath,
        inWorkspace: isInside(filePath, ctx.workspaceDir),
        content: detail.content,
      };
    }
    case "shell": {
      const trimmed = detail.output === undefined ? undefined : trimOutput(detail.output);
      const keepRaw = detail.output !== undefined && detectReviewCommand(detail.command) !== null;
      return {
        ...base,
        kind: "shell",
        command: detail.command,
        output: trimmed?.text,
        ...(keepRaw ? { rawOutput: detail.output!.slice(0, MAX_RAW_OUTPUT) } : {}),
        hiddenLines: trimmed?.hiddenLines ?? 0,
        exitCode: detail.exitCode,
      };
    }
    case "read":
      return {
        ...base,
        kind: "read",
        filePath: absolutePath(detail.filePath, ctx.agentCwd),
        content: (detail.content ?? "").slice(0, MAX_RAW_OUTPUT),
        offset: detail.offset ?? null,
        limit: detail.limit ?? null,
      };
    case "search":
      return {
        ...base,
        kind: "search",
        toolName: detail.toolName ?? "search",
        query: detail.query,
        content: detail.content,
        filePaths: (detail.filePaths ?? []).map((p) => absolutePath(p, ctx.agentCwd)),
        mode: detail.mode,
      };
    case "unknown":
    case "plain_text": {
      const input = detail.type === "unknown" && detail.input && typeof detail.input === "object" ? (detail.input as Record<string, unknown>) : {};
      return { ...base, kind: "other", name: item.name, input };
    }
    case "sub_agent":
      return {
        ...base,
        kind: "subagent",
        description: detail.description ?? detail.subAgentType ?? "sub-agent",
        actions: (detail.actions ?? []).map((a) => (a.summary ? `${a.toolName} ${a.summary}` : a.toolName)),
        callId: item.callId,
        subAgentType: detail.subAgentType,
      };
    default:
      return null;
  }
}

/** Same content, ignoring when it was seen (history and live copies differ only in `at`). */
/** Add to a history batch; a later copy of the same call (e.g. with its result) replaces the earlier one. */
export function pushHistory(list: LiveEvent[], ev: LiveEvent): LiveEvent[] {
  const index = list.findIndex((h) => h.key === ev.key);
  if (index === -1) return [...list, ev];
  const next = list.slice();
  next[index] = ev;
  return next;
}

/** A small copy for the dedupe log: big payloads only matter while review mode applies them. */
export function forLog(ev: LiveEvent): LiveEvent {
  if (ev.kind === "shell" && ev.rawOutput !== undefined) return { ...ev, rawOutput: undefined };
  if (ev.kind === "read" && ev.content) return { ...ev, content: "" };
  return ev;
}

function sameEvent(a: LiveEvent, b: LiveEvent): boolean {
  return JSON.stringify({ ...a, at: "" }) === JSON.stringify({ ...b, at: "" });
}

export function upsertEvent(
  log: EventLog,
  ev: LiveEvent,
): { log: EventLog; change: "new" | "completed" | "updated" | "none" } {
  const previous = log.byKey.get(ev.key);
  if (previous && sameEvent(previous, ev)) return { log, change: "none" };
  const byKey = new Map(log.byKey);
  byKey.set(ev.key, ev);
  if (!previous) {
    return {
      log: { byKey, order: [...log.order, ev.key] },
      change: ev.status === "running" ? "new" : "completed",
    };
  }
  const change = previous.status === "running" && ev.status !== "running" ? "completed" : "updated";
  return { log: { byKey, order: log.order }, change };
}
