import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addLivePills } from "./client/livePill";
import { LiveViewPanel } from "./client/LiveViewPanel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "live-view",
    title: "Live View",
    icon: "MonitorPlay",
    context: "workspace",
    // A main-area tab, or the Explorer side pane beside the chat (used by the Live pill).
    locations: ["workspace", "explorer"],
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
