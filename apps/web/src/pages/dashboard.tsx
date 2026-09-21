/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSearchParams } from "@solidjs/router";
import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { DashboardAccountView } from "@/components/dashboard/account-view";
import { DashboardAiCreditsView } from "@/components/dashboard/ai-credits-view";
import { DashboardBillingView } from "@/components/dashboard/billing-view";
import { DashboardGetDesktopApp } from "@/components/dashboard/get-desktop-app";
import { DashboardHelpView } from "@/components/dashboard/help-view";
import { DashboardHomeView } from "@/components/dashboard/home-view";
import { DashboardMcpView } from "@/components/dashboard/mcp-view";
import { DashboardProjectsView } from "@/components/dashboard/projects-view";
import { DashboardSearchBar } from "@/components/dashboard/search-bar";
import { DashboardSettingsView } from "@/components/dashboard/settings-view";
import {
  DashboardSidebarConnectCard,
  DashboardSidebarHeader,
  DashboardSidebarItem,
  DashboardSidebarNav,
  DashboardSidebarSection,
  DashboardSidebarTopSpacer,
  DashboardSidebarUser,
} from "@/components/dashboard/sidebar";
import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { WindowsTitleBar } from "@/components/ui/windows-title-bar";
import { useFullscreenState } from "@/hooks/use-fullscreen-state";
import { connectedAgents, fetchMcpStatus } from "@/lib/mcp";
import { isDesktop, isWindowsDesktop, openProjectFolder, pickProjectFolder } from "@/projects";
import { isInputTarget } from "@/utils";

import type { DashboardView } from "@/components/dashboard/types";

const DASHBOARD_VIEWS: readonly DashboardView[] = [
  "home",
  "projects",
  "templates",
  "ai-credits",
  "billing",
  "account",
  "settings",
  "mcp",
  "preferences",
  "help",
];

/** The views reached through the settings navigation, not the dashboard one. */
const SETTINGS_VIEWS: readonly DashboardView[] = [
  "account",
  "settings",
  "mcp",
  "ai-credits",
  "billing",
  "help",
];

// The title bar's left cell spans the sidebar (`w-69`) plus its 1px separator,
// so both borders fall on the same line.
const TITLE_BAR_SIDEBAR_WIDTH = 277;
const TITLE_BAR_CONTROLS_WIDTH = 283;

function parseView(value: string | string[] | undefined): DashboardView {
  const raw = Array.isArray(value) ? value[0] : value;
  return DASHBOARD_VIEWS.find((v) => v === raw) ?? "home";
}

function isSettingsView(view: DashboardView): boolean {
  return SETTINGS_VIEWS.includes(view);
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const isFullscreen = useFullscreenState();

  // ⌘I: the native folder picker, and the chosen folder on the recents list.
  let picking = false;
  const handleShortcut = async (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "i" || isInputTarget(event)) return;

    event.preventDefault();
    if (picking || !isDesktop()) return;
    picking = true;

    try {
      const dir = await pickProjectFolder();
      if (!dir) return;
      await openProjectFolder(dir);
    } catch (e) {
      toast.error("Failed to add project", { description: (e as Error).message });
    } finally {
      picking = false;
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleShortcut);
    onCleanup(() => window.removeEventListener("keydown", handleShortcut));
  });

  const view = (): DashboardView => parseView(params.dashboard);
  const setView = (next: DashboardView) => setParams({ dashboard: next }, { replace: true });

  // Which navigation the sidebar shows. Landing on a settings view (deep link,
  // reload) opens the settings navigation; the user row opens it by itself.
  const [settingsNavOpen, setSettingsNavOpen] = createSignal(isSettingsView(view()));

  createEffect(() => {
    if (isSettingsView(view())) {
      setSettingsNavOpen(true);
    }
  });

  const openProfile = () => {
    setSettingsNavOpen(true);
    setView("account");
  };
  const openAgentSetup = () => {
    setSettingsNavOpen(true);
    setView("mcp");
  };

  onMount(() => fetchMcpStatus().catch(() => { }));

  const showConnectCard = () => isDesktop() && connectedAgents() === 0;

  const backToDashboard = () => {
    setSettingsNavOpen(false);
    if (isSettingsView(view())) setView("home");
  };

  // The project search lives here rather than in the projects view because
  // the Windows title bar offers it on every view: typing there lands on the
  // projects it filters. Leaving the projects view drops the query.
  const [projectSearch, setProjectSearch] = createSignal("");

  const searchFromTitleBar = (value: string) => {
    setProjectSearch(value);
    if (value && view() !== "projects") {
      setSettingsNavOpen(false);
      setView("projects");
    }
  };

  createEffect(() => {
    if (view() !== "projects") setProjectSearch("");
  });

  return (
    <div class="flex h-screen w-full min-h-0 flex-row overflow-hidden bg-sidebar pt-(--titlebar-height)">
      <WindowsTitleBar
        leftWidth={TITLE_BAR_SIDEBAR_WIDTH}
        controlsWidth={TITLE_BAR_CONTROLS_WIDTH}
        left={
          <>
            <Icon name="diffusion-logo" class="size-6 shrink-0 text-muted-foreground" />
            <p class="min-w-0 flex-1 truncate text-xs font-450 text-muted-foreground">Diffusion Studio</p>
            <p class="shrink-0 text-xxs text-muted-foreground">v{APP_VERSION}</p>
          </>
        }
      >
        <DashboardSearchBar
          class="h-full"
          value={projectSearch}
          onChange={searchFromTitleBar}
          placeholder="Search in projects"
        />
      </WindowsTitleBar>
      <aside class="relative flex min-h-0 w-69 shrink-0 flex-col">
        <Show when={isDesktop() && !isWindowsDesktop() && !isFullscreen()}>
          <div class="absolute inset-x-0 top-0 h-10 z-20" style="-webkit-app-region: drag;" />
        </Show>
        {/* The Windows title bar already carries the logo, name and version. */}
        <Show when={!settingsNavOpen() && !isWindowsDesktop()} fallback={<DashboardSidebarTopSpacer />}>
          <DashboardSidebarHeader />
        </Show>
        <DashboardSidebarNav
          footer={
            <Show when={!settingsNavOpen() && showConnectCard()}>
              <DashboardSidebarConnectCard onInstall={openAgentSetup} />
            </Show>
          }
        >
          <Show
            when={settingsNavOpen()}
            fallback={
              <DashboardSidebarSection>
                <DashboardSidebarItem active={view() === "home"} onClick={() => setView("home")} icon="home" label="Home" />
                <DashboardSidebarItem active={view() === "projects"} onClick={() => setView("projects")} icon="diffusion-project-file" label="Projects" />
              </DashboardSidebarSection>
            }
          >
            <DashboardSidebarSection>
              <DashboardSidebarItem onClick={backToDashboard} icon="arrow-left" label="Back to dashboard" />
            </DashboardSidebarSection>
            <DashboardSidebarSection title="Settings">
              <DashboardSidebarItem active={view() === "account"} onClick={() => setView("account")} icon="user" label="Account" />
              <DashboardSidebarItem active={view() === "settings"} onClick={() => setView("settings")} icon="settings" label="General" />
              <DashboardSidebarItem active={view() === "mcp"} onClick={() => setView("mcp")} icon="ai-mcp-cli" label="MCP & CLI" />
              <DashboardSidebarItem active={view() === "ai-credits"} onClick={() => setView("ai-credits")} icon="ai-generate" label="AI credits" />
              <DashboardSidebarItem active={view() === "billing"} onClick={() => setView("billing")} icon="billing" label="Billing" />
              <DashboardSidebarItem active={view() === "help"} onClick={() => setView("help")} icon="help" label="Help" />
            </DashboardSidebarSection>
          </Show>
        </DashboardSidebarNav>
        <Show when={!settingsNavOpen()}>
          <DashboardSidebarUser onClick={openProfile} />
        </Show>
      </aside>

      <Separator orientation="vertical" class="bg-border-strong" />

      <section class="flex min-h-0 flex-1 flex-col bg-overlay-soft">
        <Switch>
          <Match when={view() === "home"}>
            <DashboardHomeView />
          </Match>
          <Match when={view() === "projects"}>
            <DashboardProjectsView search={projectSearch} onSearchChange={setProjectSearch} />
          </Match>
          <Match when={view() === "ai-credits"}>
            <DashboardAiCreditsView />
          </Match>
          <Match when={view() === "billing"}>
            <DashboardBillingView />
          </Match>
          <Match when={view() === "account"}>
            <DashboardAccountView />
          </Match>
          <Match when={view() === "settings"}>
            <DashboardSettingsView />
          </Match>
          <Match when={view() === "mcp"}>
            <DashboardMcpView />
          </Match>
          <Match when={view() === "help"}>
            <DashboardHelpView />
          </Match>
        </Switch>
        <DashboardGetDesktopApp />
      </section>
    </div>
  );
}
