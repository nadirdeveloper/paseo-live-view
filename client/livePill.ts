import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

type AgentLike = { id: string; workspaceId?: string | null; background?: boolean };

/** A "Live" pill in every agent's composer bar that opens the Live View tab for its workspace. */
export function addLivePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const register = (agent: AgentLike) => {
    if (lifetime.signal.aborted || !agent.workspaceId || agent.background) return;
    const workspaceId = agent.workspaceId;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "live-view",
        workspaceId,
        agentId: agent.id,
        button: {
          title: "Watch this workspace's agents live",
          icon: "MonitorPlay",
          label: "Live",
          behavior: {
            kind: "action",
            onPress() {
              // Paseo 0.17.4 has no "split" option; the Explorer side pane sits beside the chat.
              client.openPanel("live-view", { workspaceId, location: "explorer" });
            },
          },
        },
      }),
    );
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };

  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent as AgentLike);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent as AgentLike);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[live-view] agent list failed", error);
    });

  return () => {
    lifetime.abort();
    removeAll();
  };
}
