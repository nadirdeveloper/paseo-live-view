import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import { AgentFollowers, useLiveFeed } from "./client/useLiveFeed";

// Temporary debug view for Task 6; replaced by the real UI in Task 7.
function DebugPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const feed = useLiveFeed(workspaceId);
  const { player } = feed;
  const text = { color: theme.colors.foreground, fontFamily: "Menlo" };
  const muted = { color: theme.colors.foregroundMuted };
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <AgentFollowers feed={feed} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 6 }}>
        <Text style={muted}>
          agents {feed.agents.length} · files {feed.files.tree.length} top-level · queue {player.queue.length}
        </Text>
        <Text style={text}>editor: {player.editor?.filePath ?? "(none)"}</Text>
        <Text style={muted}>touched:</Text>
        {player.touched.map((p) => (
          <Text key={p} style={text}>{p}</Text>
        ))}
        <Text style={muted}>terminal:</Text>
        {player.terminal.map((e) => (
          <Text key={e.key} style={text}>
            [{e.agentLabel}] $ {e.typedCommand} {e.status === "running" ? "(running)" : `→ ${e.exitCode ?? ""}`}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "live-view",
    title: "Live View",
    icon: "MonitorPlay",
    context: "workspace",
    Component: DebugPanel,
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
