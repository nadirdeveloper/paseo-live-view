import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

function Placeholder({ theme }: PluginWorkspacePanelProps) {
  return (
    <View style={{ flex: 1, padding: 16, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground }}>Live View</Text>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "live-view",
    title: "Live View",
    icon: "MonitorPlay",
    context: "workspace",
    Component: Placeholder,
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
