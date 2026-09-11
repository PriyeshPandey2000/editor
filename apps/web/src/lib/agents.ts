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
  /** The icon file, for {@link Icon}. */
  icon: string;
  /** Whether the picker offers it, or lists it as not installed. */
  installed: boolean;
};

/** Every agent we support, in the order they are offered. */
export const AGENTS: readonly AgentInfo[] = [
  { id: "fable-5.1", label: "Fable 5.1", icon: "claude-code", installed: true },
  { id: "opus-5", label: "Opus 5", icon: "claude-code", installed: true },
  { id: "gpt-6-astra", label: "GPT-6 Astra", icon: "codex", installed: true },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", icon: "codex", installed: true },
];

/** The icon name for `agent`, falling back to a generic mark. */
export const agentIcon = (agent: AgentInfo | null | undefined): string =>
  agent?.icon ?? "fx";
