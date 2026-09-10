/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Renderer side of handing a prompt to a coding agent. The agents, their deep
// links, and which are installed all live in main (`agent-links.ts` and
// `agent-detect.ts`); this is the wrapper the dashboard calls.
//
// Off the desktop build there is no agent to reach and no config to write, so
// the list comes back empty and the connect step is a no-op.

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import type { AgentInfo, SetupResult, SetupStatus } from "@desktop/main-channels";

export type { AgentInfo, SetupResult, SetupStatus };

/**
 * The icon file for each agent, by the id `agent-links.ts` gives it. Kept on
 * this side because the icons are this app's assets: main knows the agents,
 * the renderer knows what they look like. An id with no icon of its own —
 * a newly added agent, most likely — falls back to a generic mark.
 */
const AGENT_ICONS: Record<string, string> = {
  claude: "claude",
  codex: "gpt-codex",
  conductor: "conductor",
  cursor: "cursor",
};

/** The icon name for `id`, for {@link Icon}. */
export const agentIcon = (id: string | undefined): string =>
  (id && AGENT_ICONS[id]) || "fx";

/**
 * Every agent we support, most fitting first, each flagged with whether it is
 * installed here. Empty off the desktop, where there is none to reach.
 */
export async function listAgents(): Promise<AgentInfo[]> {
  if (!window.desktop) return [];
  return mainBridge.call(MAIN_CHANNELS.AGENTS_LIST, undefined);
}

/**
 * Opens the agent's app with `prompt` in its composer, and — where the link
 * can say so — `folder` as the working directory. The agent comes to the
 * front and leaves the prompt unsent: the user reads it and presses enter.
 */
export async function launchAgent(
  id: string,
  launch: { prompt: string; folder: string | null },
): Promise<void> {
  await mainBridge.call(MAIN_CHANNELS.AGENTS_OPEN, { id, ...launch });
}

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

/**
 * The same steps as {@link ensureAgentSetup}, for a user who asked for them
 * by name rather than by sending a prompt: the CLI symlink is offered again
 * even after an earlier refusal, and the whole result comes back so the
 * caller can say what was done.
 */
export async function connectAgents(): Promise<SetupResult> {
  if (!window.desktop) throw new Error("Connecting agents needs the desktop app");

  const result = await mainBridge.call(MAIN_CHANNELS.SETUP_ENSURE, { cli: "force" });
  if (result.mcp.status === "error") throw new Error(result.mcp.error);
  return result;
}

/**
 * What setup would find on this machine, without doing any of it.
 */
export async function agentSetupStatus(): Promise<SetupStatus | null> {
  if (!window.desktop) return null;
  return mainBridge.call(MAIN_CHANNELS.SETUP_STATUS, undefined);
}

/**
 * Whether `status` leaves anything worth offering to do.
 */
export function setupPending(status: SetupStatus | null | undefined): boolean {
  if (!status) return false;
  return !status.mcp || status.cli === "missing";
}
