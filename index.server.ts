import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { listFiles, readText } from "./server/files";
import { isAllowedPath, locate, tail } from "./server/subagents";
import { subagentsLocateRpc, subagentsTailSubscription } from "./shared/subagents";
import { filesListRpc, filesReadRpc } from "./shared/files";

async function workspaceDir(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  const workspace = paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  if (!workspace.directory) throw new Error("workspace not found");
  return workspace.directory;
}

export default function contribute(server: PluginServerContext) {
  server.handle(filesListRpc, async ({ workspaceId }, { paseo }) => {
    const root = await workspaceDir(paseo, workspaceId);
    return { root, ...(await listFiles(root)) };
  });
  server.handle(filesReadRpc, async ({ workspaceId, path }, { paseo }) => {
    const root = await workspaceDir(paseo, workspaceId);
    return readText(root, path);
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
