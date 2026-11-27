import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const filesListRpc = defineRpc({
  name: "files.list",
  /** rebaseline: the panel just opened, so changes made before now are not "new" (they are history). */
  input: z.object({ workspaceId: z.string(), rebaseline: z.boolean().optional() }),
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

const fileChange = z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() });

/** Files in the workspace whose text changed since the last check (absolute paths). */
export const filesChangesRpc = defineRpc({
  name: "files.changes",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ changes: z.array(fileChange) }),
});

/** before: null = a new file; after: null = the file was deleted. */
export type FileChange = z.infer<typeof fileChange>;
