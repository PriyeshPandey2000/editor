/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app } from "electron";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installCli, isCliInstalled, isCliLinked, uninstallCli } from "./cli-install";
import { healMcpRegistrations, mcpRegistered, registerMcp, registeredAgents, unregisterMcp } from "./mcp-install";
import { pruneLegacySkills } from "./skills-cleanup";

import type { CliMode, CliSetupResult, SetupResult, SetupStatus } from "./main-channels";
import type { CliUninstallResult } from "./cli-install";
import type { McpUnregisterResult } from "./mcp-install";
import { refreshAppMenu } from "./menu";

// Linking the CLI needs an admin password, so a refusal has to be
// remembered: asking again on the next handoff is how a prompt turns into
// nagging. Only `force` — the user picking the menu item — asks again.
const DECLINED_FILE = "cli-install-declined";

const declinedPath = (): string => join(app.getPath("userData"), DECLINED_FILE);

function rememberDecline(declined: boolean): void {
  try {
    if (declined) writeFileSync(declinedPath(), "");
    else rmSync(declinedPath(), { force: true });
  } catch {
    // best effort — at worst the prompt comes back, or does not
  }
}

async function ensureCli(mode: CliMode): Promise<CliSetupResult> {
  if (isCliInstalled()) {
    return { status: "present" };
  }
  if (mode === "skip") {
    return { status: "skipped" };
  }
  // Only a packaged build has a binary to link; in dev the symlink is
  // `npm run symlink:create`, so an automatic attempt would only ever fail.
  if (mode === "auto" && (!app.isPackaged || existsSync(declinedPath()))) {
    return { status: "skipped" };
  }

  const result = await installCli();
  if (result.status !== "error") {
    rememberDecline(result.status === "cancelled");
  }
  return result;
}

/**
 * Brings this machine to the state an agent needs, and reports what it
 * found. Only `mcp` is worth failing over: without the config entry the
 * agent opens with no way to reach the app, while a missing `dapi` on PATH
 * costs the user a shell command and nothing else.
 *
 * `cli` says what to do about the symlink, which is the one step that can
 * put a password prompt on screen: `skip` at launch, `auto` before a
 * handoff (asks once, then respects a refusal), `force` when the user asked
 * for it by name.
 */
export async function ensureSetup(mode: CliMode = "auto"): Promise<SetupResult> {
  const skills = pruneLegacySkills();
  healMcpRegistrations();

  const mcp = registerMcp();
  const cli = await ensureCli(mode);

  refreshAppMenu();
  return { mcp, cli, skills };
}

/** What `disconnectSetup` did to each half of what `ensureSetup` put in place. */
export type DisconnectResult = { mcp: McpUnregisterResult; cli: CliUninstallResult };

/**
 * Whether there is anything for `disconnectSetup` to undo: an agent config
 * pointing at the app, or the `dapi` link on PATH.
 */
export function setupConnected(): boolean {
  return registeredAgents().length > 0 || isCliLinked();
}

/**
 * The inverse of `ensureSetup`: takes the app out of every agent config and
 * the `dapi` link off PATH. The configs go first because they never prompt;
 * the link comes second because it does, and a dismissed prompt should not
 * leave the agents half-disconnected. A removed link is remembered as a
 * refusal, so the next handoff does not immediately ask to put it back —
 * only "Connect Agents…" does.
 */
export async function disconnectSetup(): Promise<DisconnectResult> {
  const mcp = unregisterMcp();
  const cli = await uninstallCli();
  if (cli.status === "removed") rememberDecline(true);

  refreshAppMenu();
  return { mcp, cli };
}

/**
 * The launch pass. It repairs entries this app already owns.
 */
export function verifySetup(): SetupStatus {
  pruneLegacySkills();
  healMcpRegistrations();
  return setupStatus();
}

/** What the CLI half of setup would find, without asking for a password. */
function cliStatus(): SetupStatus["cli"] {
  if (isCliInstalled()) return "present";
  if (!app.isPackaged) return "unavailable";
  return existsSync(declinedPath()) ? "declined" : "missing";
}

/**
 * Whether the agent configs already point at this build, and where the `dapi`
 * symlink stands.
 */
export function setupStatus(): SetupStatus {
  return { mcp: mcpRegistered(), cli: cliStatus() };
}
