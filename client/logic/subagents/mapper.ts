import type { Entry } from "../../../shared/subagents";
import { absolutePath, isInside, trimOutput, type LiveEvent } from "../events";

export type MapperContext = { laneId: string; agentLabel: string; agentCwd: string; workspaceDir: string };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Claude's Read results come numbered like `cat -n` ("     1\tline"); review mode needs the raw text. */
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  const numbered = /^\s*\d+[\t→]/;
  if (!lines.filter((l) => l !== "").every((l) => numbered.test(l))) return text;
  return lines.map((l) => l.replace(numbered, "")).join("\n");
}

/** Tools that never touch workspace files. */
const IGNORED_TOOLS = new Set(["WebFetch", "WebSearch", "TodoWrite", "ExitPlanMode"]);

/** Non-empty result lines as absolute paths. */
function pathLines(result: string | undefined, cwd: string): string[] {
  return (result ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => absolutePath(l, cwd));
}

/** One subagent transcript entry → the same LiveEvents the main agent produces. */
export function entryToEvents(entry: Entry, ctx: MapperContext): LiveEvent[] {
  const base = { agentId: ctx.laneId, agentLabel: ctx.agentLabel, at: new Date().toISOString() };
  if (entry.kind !== "tool") {
    return [
      {
        ...base,
        key: `${ctx.laneId}:${entry.id}`,
        status: "completed",
        kind: "thought",
        source: entry.kind === "thinking" ? "reasoning" : "message",
        text: entry.text,
      },
    ];
  }
  const done = entry.result !== undefined;
  const status = !done ? "running" : entry.isError ? "failed" : "completed";
  const key = `${ctx.laneId}:${entry.callId}`;
  const input = entry.input;
  const file = (path: unknown) => {
    const filePath = absolutePath(str(path) ?? "", ctx.agentCwd);
    return { filePath, inWorkspace: isInside(filePath, ctx.workspaceDir) };
  };
  switch (entry.name) {
    case "Edit":
      return [{ ...base, key, status, kind: "edit", ...file(input.file_path), oldString: str(input.old_string), newString: str(input.new_string) }];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      return edits.map((e, i) => ({
        ...base,
        key: `${key}:${i}`,
        status,
        kind: "edit" as const,
        ...file(input.file_path),
        oldString: str(e.old_string),
        newString: str(e.new_string),
      }));
    }
    case "Write":
      return [{ ...base, key, status, kind: "write", ...file(input.file_path), content: str(input.content) }];
    case "Bash": {
      const trimmed = done ? trimOutput(entry.result ?? "") : null;
      return [
        {
          ...base,
          key,
          status,
          kind: "shell",
          command: str(input.command) ?? "",
          output: trimmed?.text,
          // Review mode reads diffs from the full output, like the main agent's review commands.
          ...(done ? { rawOutput: entry.result } : {}),
          hiddenLines: trimmed?.hiddenLines ?? 0,
          exitCode: done ? (entry.isError ? 1 : 0) : undefined,
        },
      ];
    }
    case "Read":
      return [
        {
          ...base,
          key,
          status,
          kind: "read",
          filePath: absolutePath(str(input.file_path) ?? "", ctx.agentCwd),
          content: stripLineNumbers(entry.result ?? ""),
          offset: num(input.offset),
          limit: num(input.limit),
        },
      ];
    case "Agent":
    case "Task":
      return [
        {
          ...base,
          key,
          status,
          kind: "subagent",
          description: str(input.description) ?? str(input.subagent_type) ?? "sub-agent",
          actions: [],
          callId: entry.callId,
          subAgentType: str(input.subagent_type),
        },
      ];
    case "Grep": {
      const mode = (str(input.output_mode) ?? "files_with_matches") as "content" | "files_with_matches" | "count";
      return [
        {
          ...base,
          key,
          status,
          kind: "search",
          toolName: "grep",
          query: str(input.pattern) ?? "",
          content: entry.result,
          filePaths: mode === "files_with_matches" ? pathLines(entry.result, ctx.agentCwd) : [],
          mode,
        },
      ];
    }
    case "Glob":
      return [
        { ...base, key, status, kind: "search", toolName: "glob", query: str(input.pattern) ?? "", filePaths: pathLines(entry.result, ctx.agentCwd) },
      ];
    default:
      if (IGNORED_TOOLS.has(entry.name)) return [];
      return [{ ...base, key, status, kind: "other", name: entry.name, input }];
  }
}
