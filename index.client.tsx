import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LiveViewPanel } from "./client/LiveViewPanel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "live-view",
    title: "Live View",
    icon: "MonitorPlay",
    context: "workspace",
    Component: LiveViewPanel,
  });
  client.addCommandCenterItem({
    id: "open-live-view",
    title: "Open Live View",
    icon: "MonitorPlay",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("live-view");
    },
  });
  return () => {};
}
