import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { listFiles, readText } from "./server/files";
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
  return () => {};
}
