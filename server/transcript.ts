import type { Entry } from "../shared/subagents";

/**
 * Turns Claude Code subagent transcript lines (JSONL) into entries. Each content block is its own
 * line; lines of one message share `message.id`. Only assistant blocks and user tool results matter.
 */
export type Normalizer = { push(lines: string[]): Entry[] };

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && typeof (c as Block).text === "string" ? (c as Block).text : "")).join("");
  }
  return "";
}

export function createNormalizer(): Normalizer {
  const seenLines = new Set<string>();
  const blockCount = new Map<string, number>();
  const tools = new Map<string, Extract<Entry, { kind: "tool" }>>();

  return {
    push(lines) {
      const out: Entry[] = [];
      for (const line of lines) {
        if (!line.trim() || seenLines.has(line)) continue;
        seenLines.add(line);
        let row: { type?: string; message?: { id?: string | null; content?: unknown } };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const content = row.message?.content;
        if (!Array.isArray(content)) continue;
        if (row.type === "assistant") {
          const messageId = row.message?.id ?? "msg";
          for (const block of content as Block[]) {
            const index = blockCount.get(messageId) ?? 0;
            blockCount.set(messageId, index + 1);
            if ((block.type === "thinking" || block.type === "text") && (block.thinking ?? block.text)) {
              out.push({ kind: block.type, id: `${messageId}:${index}`, text: (block.type === "thinking" ? block.thinking : block.text) ?? "" });
            } else if (block.type === "tool_use" && block.id && block.name) {
              const entry: Extract<Entry, { kind: "tool" }> = {
                kind: "tool",
                callId: block.id,
                name: block.name,
                input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
              };
              tools.set(block.id, entry);
              out.push(entry);
            }
          }
        } else if (row.type === "user") {
          for (const block of content as Block[]) {
            if (block.type !== "tool_result" || !block.tool_use_id) continue;
            const call = tools.get(block.tool_use_id);
            if (!call) continue;
            const updated = { ...call, result: resultText(block.content), isError: block.is_error === true };
            tools.set(block.tool_use_id, updated);
            out.push(updated);
          }
        }
      }
      return out;
    },
  };
}
