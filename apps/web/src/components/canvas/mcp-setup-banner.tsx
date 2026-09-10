/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createResource, createSignal, onCleanup } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useEditorApi } from "@/dapi";
import { agentSetupStatus, connectAgents, setupPending } from "@/lib/agents";
import { track } from "@/lib/analytics";
import { createStoredSignal } from "@/lib/store";
import { store } from "@/init";

import type { SetupResult } from "@/lib/agents";

// The same artwork the download promo uses — one card, two steps of the
// same story, so the second one is recognisably the first one's sequel.
const BANNER_IMAGE = new URL("@/assets/images/desktop-app-banner.png", import.meta.url).href;

/**
 * The desktop counterpart of {@link DesktopAppBanner}: same card, same
 * corner, but for the step after installing the app — pointing the coding
 * agents on this machine at its MCP server. It appears only while there is
 * something left to do (`setup:status` checks the agent configs and the
 * `dapi` symlink both, without writing either), and goes away the moment
 * setup completes, whether from this button or the app menu.
 */
export function McpSetupBanner() {
  const { isDesktop } = useEditorApi();
  const [dismissed, setDismissed] = createStoredSignal(
    store.define("canvas.mcp-setup-banner-dismissed", false),
  );
  const [status, { refetch }] = createResource(agentSetupStatus);
  const [busy, setBusy] = createSignal(false);

  // Connecting can also happen from the app menu, and the admin prompt takes
  // the window's focus with it — coming back is the moment to look again.
  const handleFocus = () => void refetch();
  window.addEventListener("focus", handleFocus);
  onCleanup(() => window.removeEventListener("focus", handleFocus));

  const handleDismiss = () => {
    track("mcp_setup_banner_dismissed", { source: "canvas_banner" });
    setDismissed(true);
  };

  const handleConnect = async () => {
    if (busy()) return;
    setBusy(true);

    try {
      const result = await connectAgents();
      track("mcp_setup_connected", { source: "canvas_banner", cli: result.cli.status });
      toast("Your agents are connected", { description: describe(result) });
    } catch (e) {
      toast.error("Could not connect your agents", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
      // The card hides itself once nothing is left to do.
      await refetch();
    }
  };

  return (
    <Show when={isDesktop && !dismissed() && setupPending(status())}>
      <div class="absolute bottom-4 left-4 z-10 flex w-[220px] flex-col gap-1 rounded-md border border-border bg-background pb-3 shadow-[0px_0px_1px_2px_rgba(0,0,0,0.12),0px_4px_12px_8px_rgba(0,0,0,0.12)]">
        <div class="relative aspect-[220/122] w-full overflow-hidden rounded-t-md">
          <img src={BANNER_IMAGE} alt="" class="pointer-events-none size-full object-cover" />
          <button
            type="button"
            aria-label="Dismiss"
            class="absolute right-1 top-1 text-muted-foreground transition-colors hover:text-foreground"
            onClick={handleDismiss}
          >
            <Icon name="close-remove" />
          </button>
        </div>
        <div class="flex flex-col gap-3 px-3">
          <div class="flex flex-col gap-0.5">
            <div class="flex h-7 items-center">
              <span class="truncate text-xs font-450 leading-4 text-foreground">
                Connect your coding agents
              </span>
            </div>
            <p class="text-xs leading-4 text-muted-foreground">
              Point Claude Code, Codex, or another coding agent at this app so it can analyze
              footage and edit your project.
            </p>
          </div>
          <Button
            variant="secondary"
            class="w-full gap-1"
            disabled={busy()}
            onClick={handleConnect}
          >
            <Show when={busy()} fallback="Connect agents">
              <Icon name="spinner-loader" class="animate-spin" />
              Connecting…
            </Show>
          </Button>
        </div>
      </div>
    </Show>
  );
}

/** What the toast says about a finished setup, one line per step that did something. */
function describe({ mcp, cli }: SetupResult): string {
  const lines: string[] = [];

  if (mcp.status === "registered") {
    lines.push(`${mcp.agents.join(", ")} can now reach this app — restart the agent to pick it up.`);
  }
  if (cli.status === "installed") lines.push('The "dapi" command is now on your PATH.');
  if (cli.status === "cancelled") lines.push('Skipped linking the "dapi" command line tool.');
  if (cli.status === "error") lines.push(`The "dapi" command could not be linked: ${cli.error}`);

  return lines.join(" ");
}
