/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { AGENTS, agentLink, findAgent, pickVariant } from "./agent-links";

import type { AgentLaunch, AgentVariant } from "./agent-links";
import type { AgentInfo } from "./main-channels";

function markerExists(marker: string): boolean {
  return existsSync(isAbsolute(marker) ? marker : join(homedir(), marker));
}

/** Whether this app is on this machine and can answer its link. */
const variantAvailable = (variant: AgentVariant): boolean =>
  variant.markers.some(markerExists);

/**
 * Every agent we support, in the order they are offered, each saying whether
 * anything on this machine answers its link. The unavailable ones are listed
 * too: the picker shows them disabled rather than hiding them, so the list
 * reads the same everywhere and names what is missing.
 */
export function listAgents(): AgentInfo[] {
  return AGENTS.map(({ id, label, folder, variants }) => ({
    id,
    label,
    folder,
    available: variants.some(variantAvailable),
  }));
}

/**
 * The deep link for the agent `id` — through the best of its apps that is
 * installed — or null when there is no such agent or nothing to open it.
 */
export function agentLaunchUrl(id: string, launch: AgentLaunch): string | null {
  const agent = findAgent(id);
  if (!agent) return null;

  const variant = pickVariant(agent, variantAvailable);
  return variant ? agentLink(agent, variant, launch) : null;
}
