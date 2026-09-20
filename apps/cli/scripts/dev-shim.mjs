/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Windows counterpart of `symlink:create`: points the `dapi` shim at this
// workspace's build, run on the system's Node. It goes where the packaged app
// keeps its own shim (apps/desktop/src/cli-windows.ts), which is also where a
// dev build of the app looks for the binary it registers with agents. The two
// share the file: a packaged app rewrites it on launch, so run this again
// after using one.
//
//   node scripts/dev-shim.mjs            write the shim
//   node scripts/dev-shim.mjs --remove   delete it

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("dev-shim is for Windows; use `npm run symlink:create` on macOS.");
  process.exit(1);
}

const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const dir = join(local, "DiffusionStudio", "bin");
const shim = join(dir, "dapi.cmd");

if (process.argv.includes("--remove")) {
  rmSync(shim, { force: true });
  console.log(`dev-shim: removed ${shim}`);
  process.exit(0);
}

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const batch = (path) => path.replaceAll("%", "%%");

mkdirSync(dir, { recursive: true });
writeFileSync(shim, ["@echo off", "setlocal", `node "${batch(script)}" %*`, ""].join("\r\n"));
console.log(`dev-shim: ${shim} -> ${script}`);

const onPath = (process.env.PATH ?? "")
  .split(";")
  .some((entry) => win32.normalize(entry).replace(/\\+$/, "").toLowerCase() === dir.toLowerCase());
if (!onPath) console.log(`dev-shim: add ${dir} to your PATH to run \`dapi\` from a terminal.`);
