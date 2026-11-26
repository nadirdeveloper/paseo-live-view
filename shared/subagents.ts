import { defineRpc, defineSubscription } from "@getpaseo/plugin";
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

export const subagentsLocateRpc = defineRpc({
  name: "subagents.locate",
  input: z.object({ toolUseId: z.string(), cwd: z.string() }),
  output: z.object({
    found: z.boolean(),
    path: z.string().optional(),
    meta: z
      .object({
        agentType: z.string().optional(),
        description: z.string().optional(),
        spawnDepth: z.number().optional(),
        background: z.boolean(),
      })
      .optional(),
  }),
});

export const subagentsTailSubscription = defineSubscription({
  name: "subagents.tail",
  input: z.object({ path: z.string() }),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("entries"), entries: z.array(EntrySchema) }),
    z.object({ type: z.literal("status"), status: z.enum(["running", "done", "idle"]) }),
  ]),
});
