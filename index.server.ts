import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { listFiles, readText, resolveInside } from "./server/files";
import { createSnapshots } from "./server/snapshot";
import { isAllowedPath, locate, tail } from "./server/subagents";
import { subagentsLocateRpc, subagentsTailSubscription } from "./shared/subagents";
import { filesChangesRpc, filesListRpc, filesReadRpc } from "./shared/files";

async function workspaceDir(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  const workspace = paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  if (!workspace.directory) throw new Error("workspace not found");
  return workspace.directory;
}

export default function contribute(server: PluginServerContext) {
  // Copies of workspace text files, so edits made by shell commands can be replayed (memory only).
  const snapshots = createSnapshots();
  server.handle(filesListRpc, async ({ workspaceId, rebaseline }, { paseo }) => {
    const root = await workspaceDir(paseo, workspaceId);
    const listed = await listFiles(root);
    (rebaseline ? snapshots.rebaseline(root) : snapshots.prime(root)).catch((error) => console.error("[live-view] snapshot failed", error));
    return { root, ...listed };
  });
  server.handle(filesReadRpc, async ({ workspaceId, path }, { paseo }) => {
    const root = await workspaceDir(paseo, workspaceId);
    const result = await readText(root, path);
    if (result.status === "ok") {
      // The panel shows this text now, so a later check shouldn't report it again as a change.
      const target = await resolveInside(root, path);
      if (target) snapshots.remember(root, target, result.text);
    }
    return result;
  });
  server.handle(filesChangesRpc, async ({ workspaceId }, { paseo }) => {
    const root = await workspaceDir(paseo, workspaceId);
    return { changes: await snapshots.changes(root) };
  });
  server.handle(subagentsLocateRpc, async ({ toolUseId, cwd }) => {
    const found = await locate(homedir(), toolUseId, cwd);
    return found ? { found: true, path: found.path, meta: found.meta } : { found: false };
  });
  server.handle(subagentsTailSubscription, ({ path }, { push, signal }) => {
    // Only transcripts this process located itself (matched by tool call id) may be read.
    if (!isAllowedPath(path)) throw new Error("subagent transcript not located");
    void tail(
      path,
      (entries) => void push({ type: "entries", entries }),
      (status) => void push({ type: "status", status }),
      signal,
    ).catch((error) => console.error("[live-view] subagent tail failed", error));
  });
  return () => {};
}
