/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app } from "electron";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installCli, isCliInstalled } from "./cli-install";
import { healMcpRegistrations, registerMcp } from "./mcp-install";
import { pruneLegacySkills } from "./skills-cleanup";

import type { CliMode, CliSetupResult, SetupResult } from "./main-channels";

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
export async function ensureSetup({ cli = "auto" }: { cli?: CliMode } = {}): Promise<SetupResult> {
  const skills = pruneLegacySkills();
  healMcpRegistrations();
  const mcp = registerMcp();
  return { mcp, cli: await ensureCli(cli), skills };
}
