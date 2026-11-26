import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addLivePills } from "./client/livePill";
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
  // A "Live" pill on every agent tab opens this panel.
  return addLivePills(client);
}
