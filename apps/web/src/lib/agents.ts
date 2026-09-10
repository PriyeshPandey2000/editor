/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The coding agents the dashboard offers. Nothing is detected: the list, and
// which of them counts as installed, is fixed here.

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

/** A coding agent the home view's picker offers. */
export type AgentInfo = {
  /** Stable id — what the picker remembers the user's choice as. */
  id: string;
  label: string;
  /** Whether the picker offers it, or lists it as not installed. */
  installed: boolean;
};

/** Every agent we support, in the order they are offered. */
export const AGENTS: readonly AgentInfo[] = [
  { id: "claude", label: "Claude Code", installed: true },
  { id: "codex", label: "Codex", installed: false },
];

/** The icon file for each agent, for {@link Icon}. */
const AGENT_ICONS: Record<string, string> = {
  claude: "claude",
  codex: "gpt-codex",
};

/** The icon name for `id`, falling back to a generic mark. */
export const agentIcon = (id: string | undefined): string =>
  (id && AGENT_ICONS[id]) || "fx";

/**
 * Brings this machine to the state the agent needs: its config pointing at
 * this app's MCP server, the `dapi` CLI on PATH, and no stale skills left
 * over from older builds. Main does the work (`setup.ts`) and every step is
 * idempotent, so this runs before each handoff rather than at some quieter
 * moment — the agent reads its config at startup, and the link is what
 * starts it.
 *
 * It throws only when the MCP config could not be written, because that is
 * the one failure that would send the agent off without its tools. The CLI
 * is for the user's own shell, so its outcome is not this path's business.
 */
export async function ensureAgentSetup(): Promise<void> {
  if (!window.desktop) return;

  const { mcp } = await mainBridge.call(MAIN_CHANNELS.SETUP_ENSURE, {});
  if (mcp.status === "error") throw new Error(mcp.error);
}
