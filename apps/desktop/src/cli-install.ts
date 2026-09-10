/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { CliInstallResult } from "./main-channels";

// Outcome of taking the symlink back out. "absent" means there was none to
// remove; "cancelled" that the admin prompt was dismissed and it stays.
export type CliUninstallResult =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

export const CLI_LINK_PATH = "/usr/local/bin/dapi";

// The dev workflow links the workspace build into Homebrew's bin instead
// (`symlink:create` in apps/cli), so both locations count as installed.
const DEV_LINK_PATH = "/opt/homebrew/bin/dapi";

export function isCliInstalled(): boolean {
  return existsSync(CLI_LINK_PATH) || existsSync(DEV_LINK_PATH);
}

/**
 * Whether the link this app creates is there — dangling or not, since a
 * link left behind by a deleted bundle is exactly what removal is for.
 * `existsSync` follows links and would miss that case.
 */
export function isCliLinked(): boolean {
  return lstatSync(CLI_LINK_PATH, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

// Linking into /usr/local/bin needs elevation; osascript shows the standard
// macOS admin prompt so the app itself never asks for credentials.
function linkCli(): Promise<void> {
  const wrapper = join(process.resourcesPath, "cli", "bin", "dapi");
  const shell = `mkdir -p /usr/local/bin && ln -sf '${wrapper}' '${CLI_LINK_PATH}'`;
  const script = `do shell script "${shell.replaceAll('"', '\\"')}" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
  });
}

// The same elevation for the removal, with the same prompt.
function unlinkCli(): Promise<void> {
  const script = `do shell script "rm -f '${CLI_LINK_PATH}'" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
  });
}

export async function installCli(): Promise<CliInstallResult> {
  if (!app.isPackaged) {
    return {
      status: "error",
      error: "Installing the CLI is only available in the packaged app. Use `npm run symlink:create` in development.",
    };
  }
  try {
    await linkCli();
    return { status: "installed" };
  } catch (e) {
    const message = (e as Error).message ?? "";
    if (message.includes("-128")) return { status: "cancelled" }; // user cancelled the admin prompt
    return { status: "error", error: message };
  }
}

/**
 * Removes the `dapi` link from PATH. Only the link at {@link CLI_LINK_PATH}
 * is touched, and only when it is a symlink: a real binary somebody put
 * there is not ours to delete, and the dev link in Homebrew's bin belongs
 * to `npm run symlink:remove`.
 */
export async function uninstallCli(): Promise<CliUninstallResult> {
  const stat = lstatSync(CLI_LINK_PATH, { throwIfNoEntry: false });
  if (!stat) return { status: "absent" };
  if (!stat.isSymbolicLink()) {
    return { status: "error", error: `${CLI_LINK_PATH} is not a link this app created, so it was left alone.` };
  }
  try {
    await unlinkCli();
    return { status: "removed" };
  } catch (e) {
    const message = (e as Error).message ?? "";
    if (message.includes("-128")) return { status: "cancelled" }; // user cancelled the admin prompt
    return { status: "error", error: message };
  }
}
