import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const filesListRpc = defineRpc({
  name: "files.list",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ root: z.string(), paths: z.array(z.string()), capped: z.boolean() }),
});

const filesReadOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), text: z.string() }),
  z.object({ status: z.enum(["outside", "missing", "too-large", "binary"]) }),
]);

export const filesReadRpc = defineRpc({
  name: "files.read",
  input: z.object({ workspaceId: z.string(), path: z.string() }),
  output: filesReadOutput,
});

export type FilesReadOutput = z.infer<typeof filesReadOutput>;
export type FilesListOutput = z.infer<typeof filesListRpc.output>;
