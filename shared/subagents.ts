import { z } from "zod";

/** One step from a Claude Code subagent transcript, normalized on the server. */
export const EntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    result: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  z.object({ kind: z.enum(["thinking", "text"]), id: z.string(), text: z.string() }),
]);

export type Entry = z.infer<typeof EntrySchema>;
