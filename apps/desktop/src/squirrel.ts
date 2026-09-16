/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Squirrel.Windows starts the app once for each install, update, and
// uninstall, with a `--squirrel-*` flag as the only argument, and expects it
// to do its housekeeping and exit. That is the moment the Start Menu
// shortcut is created and removed (through Squirrel's own Update.exe, one
// folder up from the versioned app folder), and — from later stages — where
// the `dapi` shim and the agents' MCP entries get written and cleaned up.
// `--squirrel-firstrun` is the ordinary first launch and is not an event.

import { app } from "electron";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";

const EVENTS = new Set(["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall", "--squirrel-obsolete"]);

/** The `--squirrel-*` event this launch is, or null when it is a real launch. */
export function squirrelEvent(argv: string[] = process.argv, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  const flag = argv[1];
  return flag && EVENTS.has(flag) ? flag : null;
}

/** Runs Update.exe with `args` and quits once it is done. Quits at once if it cannot be started. */
function updateExe(args: string[]): void {
  const exe = resolve(process.execPath, "..", "..", "Update.exe");
  let child;
  try {
    child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  } catch {
    app.quit();
    return;
  }
  child.on("error", () => app.quit());
  child.on("close", () => app.quit());
}

/**
 * Handles a Squirrel event launch. Returns true when this launch was one —
 * the caller must then not open a window or start any service; the app
 * quits by itself once the housekeeping is done.
 */
export function handleSquirrelEvent(): boolean {
  const event = squirrelEvent();
  if (!event) return false;

  const target = basename(process.execPath);
  switch (event) {
    case "--squirrel-install":
    case "--squirrel-updated":
      updateExe(["--createShortcut", target]);
      break;
    case "--squirrel-uninstall":
      updateExe(["--removeShortcut", target]);
      break;
    default:
      // --squirrel-obsolete: the version being replaced gets a last word; we have none.
      app.quit();
  }
  return true;
}
