/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The coding agents the dashboard offers. Nothing is detected: the list, and
// which of them counts as installed, is fixed here.

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
