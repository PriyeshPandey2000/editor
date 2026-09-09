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

import type { AgentInfo } from "@desktop/main-channels";

export type { AgentInfo };

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
 * Points the agents on this machine at this app's MCP server, unless one
 * already is. Without it the agent opens with the prompt but has no way to
 * touch the project, so this runs before the prompt is handed over rather
 * than at some quieter moment — and it throws when it cannot, because
 * carrying on would send the agent off without its tools.
 */
export async function connectAgents(): Promise<void> {
  if (!window.desktop) return;
  if (await mainBridge.call(MAIN_CHANNELS.MCP_IS_REGISTERED, undefined)) return;

  const result = await mainBridge.call(MAIN_CHANNELS.MCP_REGISTER, undefined);
  if (result.status === "error") throw new Error(result.error);
}
