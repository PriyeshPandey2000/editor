/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AGENT_ICONS,
  applyMcp,
  displayPath,
  fetchCliStatus,
  fetchMcpStatus,
  installCli,
  uninstallCli,
  type AgentId,
  type McpAgentStatus,
} from "@/lib/mcp";
import { isDesktop } from "@/projects";

import {
  DashboardDividedStack,
  DashboardInfoActionRow,
  DashboardScrollView,
  DashboardSurfaceCard,
  DashboardSurfaceSection,
  DashboardTitledSection,
} from "./shared";

function DashboardCliSection() {
  const [status, { refetch }] = createResource(fetchCliStatus);
  const [busy, setBusy] = createSignal(false);

  const description = () => {
    const current = status();
    if (!current) return "Checking...";
    if (current.installed) return `Installed at ${current.path}`;
    if (!current.available) return "Not installed. Available in the packaged app; in development, run npm run symlink:create.";
    return "Not installed";
  };

  const handleInstall = async () => {
    setBusy(true);
    try {
      const result = await installCli();
      if (result.status === "installed") toast("CLI installed", { description: "Run dapi --help in a terminal to get started." });
      if (result.status === "error") toast.error("Could not install the CLI", { description: result.error });
    } catch (e) {
      toast.error("Could not install the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      const result = await uninstallCli();
      if (result.status === "removed") toast("CLI uninstalled");
      if (result.status === "error") toast.error("Could not uninstall the CLI", { description: result.error });
    } catch (e) {
      toast.error("Could not uninstall the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  return (
    <DashboardSurfaceSection
      title="Command line"
      description="With the CLI installed, agents can launch Diffusion Studio on their own, in the background if they like."
    >
      <DashboardInfoActionRow
        title="dapi"
        leading={<Icon name="command-slash" class="text-foreground" />}
        description={description()}
        action={
          <Switch>
            <Match when={!status()}>
              <Button variant="secondary" disabled>
                Install
              </Button>
            </Match>
            <Match when={status()?.installed && status()?.managed}>
              <Button variant="secondary" disabled={busy()} onClick={handleUninstall}>
                Uninstall
              </Button>
            </Match>
            <Match when={status()?.installed}>
              <Tooltip>
                <TooltipTrigger as={Button} variant="on">
                  Installed
                </TooltipTrigger>
                <TooltipContent>Not a link, so it is left alone.</TooltipContent>
              </Tooltip>
            </Match>
            <Match when={status()?.available}>
              <Button disabled={busy()} onClick={handleInstall}>
                Install
              </Button>
            </Match>
            <Match when={true}>
              <Button variant="secondary" disabled>
                Unavailable
              </Button>
            </Match>
          </Switch>
        }
      />
    </DashboardSurfaceSection>
  );
}

// --- Agents ------------------------------------------------------------------

type PendingChange = "add" | "remove";
type Pending = Partial<Record<AgentId, PendingChange>>;

type AgentRowProps = {
  agent: McpAgentStatus;
  pending: PendingChange | undefined;
  onToggle: () => void;
};

function AgentRow(props: AgentRowProps) {
  const description = () => {
    const { agent } = props;
    if (props.pending === "add") return <span class="text-primary">Will be added</span>;
    if (props.pending === "remove") return <span class="text-destructive">Will be removed</span>;
    if (agent.connected) return `Connected · ${displayPath(agent.config)}`;
    if (agent.unavailable) return agent.unavailable;
    if (!agent.detected) return "Not found on this Mac";
    return "Not connected";
  };

  return (
    <DashboardInfoActionRow
      layout="inline"
      title={props.agent.label}
      leading={<Icon name={AGENT_ICONS[props.agent.id]} class="text-foreground" />}
      description={description()}
      action={
        <Switch>
          <Match when={props.pending}>
            <Button variant="secondary" onClick={props.onToggle}>
              Undo
            </Button>
          </Match>
          <Match when={props.agent.connected}>
            <Tooltip>
              <TooltipTrigger
                as={Button}
                variant="ghost"
                size="icon"
                aria-label={`Remove from ${props.agent.label}`}
                onClick={props.onToggle}
              >
                <Icon name="minus" />
              </TooltipTrigger>
              <TooltipContent>Remove from {props.agent.label}</TooltipContent>
            </Tooltip>
          </Match>
          <Match when={true}>
            <Tooltip>
              <TooltipTrigger
                as={Button}
                variant="ghost"
                size="icon"
                aria-label={`Add to ${props.agent.label}`}
                disabled={props.agent.unavailable !== null}
                onClick={props.onToggle}
              >
                <Icon name="plus-add" />
              </TooltipTrigger>
              <TooltipContent>Add to {props.agent.label}</TooltipContent>
            </Tooltip>
          </Match>
        </Switch>
      }
    />
  );
}

function DashboardAgentsSection() {
  const [status, { refetch }] = createResource(fetchMcpStatus);
  const [pending, setPending] = createSignal<Pending>({});
  const [saving, setSaving] = createSignal(false);

  const ids = (change: PendingChange): AgentId[] =>
    (Object.entries(pending()) as [AgentId, PendingChange][])
      .filter(([, value]) => value === change)
      .map(([id]) => id);
  const toAdd = () => ids("add");
  const toRemove = () => ids("remove");
  const hasChanges = () => toAdd().length + toRemove().length > 0;

  const summary = () => {
    const parts = [
      toAdd().length > 0 ? `${toAdd().length} to add` : null,
      toRemove().length > 0 ? `${toRemove().length} to remove` : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" · ");
  };

  const toggle = (agent: McpAgentStatus) => {
    setPending((current) => {
      const next = { ...current };
      if (next[agent.id]) delete next[agent.id];
      else next[agent.id] = agent.connected ? "remove" : "add";
      return next;
    });
  };

  const discard = () => setPending({});

  const labelOf = (id: AgentId) => status()?.agents.find((agent) => agent.id === id)?.label ?? id;

  const save = async () => {
    if (!hasChanges() || saving()) return;
    setSaving(true);
    try {
      const result = await applyMcp({ add: toAdd(), remove: toRemove() });

      // Only what failed stays pending, so a retry is one click away.
      setPending((current) => {
        const next: Pending = {};
        for (const failure of result.failures) {
          const change = current[failure.id];
          if (change) next[failure.id] = change;
        }
        return next;
      });

      const changed = result.added.length + result.removed.length;
      if (result.failures.length > 0) {
        toast.error(changed > 0 ? "Some agents could not be updated" : "Agents could not be updated", {
          description: result.failures.map((failure) => `${labelOf(failure.id)}: ${failure.error}`).join("\n"),
        });
      } else {
        toast("Agents updated", { description: "Restart the agent to pick up the change." });
      }
    } catch (e) {
      toast.error("Could not update the agents", { description: (e as Error).message });
    } finally {
      setSaving(false);
      void refetch();
    }
  };

  return (
    <DashboardTitledSection
      title="Agents"
      description="Adds Diffusion Studio as an MCP server to each agent's configuration, so the agent can inspect, generate, and edit your projects."
    >
      <DashboardSurfaceCard class="flex flex-col gap-3">
        <Show
          when={status()}
          fallback={<p class="text-xs text-muted-foreground">Checking agents...</p>}
        >
          {(current) => (
            <DashboardDividedStack>
              <For each={current().agents}>
                {(agent) => (
                  <AgentRow agent={agent} pending={pending()[agent.id]} onToggle={() => toggle(agent)} />
                )}
              </For>
            </DashboardDividedStack>
          )}
        </Show>
      </DashboardSurfaceCard>
      <Show when={hasChanges()}>
        <div class="flex items-center gap-2 px-2 pt-3">
          <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary()}</p>
          <Button variant="ghost" disabled={saving()} onClick={discard}>
            Discard
          </Button>
          <Button disabled={saving()} onClick={save}>
            Save changes
          </Button>
        </div>
      </Show>
    </DashboardTitledSection>
  );
}

// --- Any other agent ---------------------------------------------------------

function DashboardEndpointSection() {
  const [status] = createResource(fetchMcpStatus);

  const copy = async () => {
    const url = status()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast("Copied!", { description: "The MCP endpoint has been copied to your clipboard." });
    } catch (e) {
      toast.error("Failed to copy", { description: (e as Error).message });
    }
  };

  return (
    <DashboardSurfaceSection title="Other agents">
      <DashboardInfoActionRow
        title="MCP endpoint"
        description={
          <>
            Any agent that speaks Streamable HTTP can be pointed at{" "}
            <span class="font-mono text-foreground">{status()?.url ?? "..."}</span> while the app is running.
          </>
        }
        action={
          <Tooltip>
            <TooltipTrigger
              as={Button}
              variant="ghost"
              size="icon"
              aria-label="Copy the MCP endpoint"
              disabled={!status()}
              onClick={copy}
            >
              <Icon name="clipboard" />
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
        }
      />
    </DashboardSurfaceSection>
  );
}

export function DashboardMcpView() {
  return (
    <DashboardScrollView>
      <Show
        when={isDesktop()}
        fallback={
          <DashboardSurfaceSection title="MCP & CLI">
            <p class="text-xs text-muted-foreground">
              Connecting coding agents and installing the command line tool is available in the desktop app.
            </p>
          </DashboardSurfaceSection>
        }
      >
        <DashboardCliSection />
        <DashboardAgentsSection />
        <DashboardEndpointSection />
      </Show>
      <div class="px-2 pt-1 text-xs text-muted-foreground">
        <span>Other agents can be connected by hand. </span>
        <a
          href="https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers"
          target="_blank"
          class="text-primary hover:underline"
        >
          Learn more
        </a>
      </div>
    </DashboardScrollView>
  );
}
