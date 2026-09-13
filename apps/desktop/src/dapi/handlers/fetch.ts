/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn, spawnSync } from "node:child_process";
import { DapiError } from "@diffusionstudio/dapi";
import { hydrateEnv, which } from "@diffusionstudio/agent-chat/host/env";

import type { HostEnv } from "@diffusionstudio/agent-chat/host/env";
import type { MainHandler } from "../handler";

// A Finder- or Dock-launched app inherits launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which is where a Homebrew or pipx yt-dlp
// is not. The login shell's PATH is read once and searched, then the usual
// install dirs; YT_DLP_PATH is an escape hatch for pinned installs. The
// hydrated env is also what yt-dlp runs with, so it finds ffmpeg for merging
// and extraction the same way.
let hostEnv: Promise<HostEnv> | undefined;

function host(): Promise<HostEnv> {
  return (hostEnv ??= hydrateEnv());
}

/** Where yt-dlp is, or null when it is nowhere the app can see. */
async function resolveYtDlp(): Promise<{ bin: string; env: HostEnv["env"] } | null> {
  const env = await host();
  const override = env.env.YT_DLP_PATH ?? process.env.YT_DLP_PATH;
  const bin = override ?? which("yt-dlp", env);
  return bin ? { bin, env: env.env } : null;
}

// Fails with an actionable message before any download is attempted. Not
// found is the "not installed" case; a non-zero status means the binary is
// present but broken.
async function requireYtDlp(): Promise<{ bin: string; env: HostEnv["env"] }> {
  const resolved = await resolveYtDlp();
  if (!resolved) {
    throw new DapiError(
      "unsupported",
      "yt-dlp not found. Install it (brew install yt-dlp, or pipx install yt-dlp) or set YT_DLP_PATH to its location.",
    );
  }
  const probe = spawnSync(resolved.bin, ["--version"], { encoding: "utf8", env: resolved.env });
  if (probe.error) {
    if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DapiError("unsupported", `yt-dlp is not runnable at ${resolved.bin}. Install it, or point YT_DLP_PATH at a working binary.`);
    }
    throw probe.error;
  }
  if (probe.status !== 0) {
    throw new DapiError("unsupported", probe.stderr?.trim() || "yt-dlp is present but not runnable.");
  }
  return resolved;
}

// yt-dlp's own `after_move:filepath` reports what actually landed (post
// extraction / rename), so the name is never guessed. --quiet keeps stdout to
// those paths; stderr is kept only for the error line when it fails.
export const fetchVideo: MainHandler<"fetch"> = async ({ url, output, format, audio, raw }, ctx) => {
  const { bin, env } = await requireYtDlp();

  const args = ["--quiet", "--no-warnings", "--print", "after_move:filepath"];
  if (output) args.push("-o", output);
  if (format) {
    args.push("-f", format);
  } else if (!audio) {
    // Default to mp4: prefer mp4/m4a streams, then remux the merged result so
    // the landed file is a .mp4 even when only WebM/mkv sources were available.
    // An explicit format or audio opts out.
    args.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4");
  }
  if (audio) args.push("-x");
  if (raw?.length) args.push(...raw);
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });

    const onAbort = () => child.kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", reject);
    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (ctx.signal.aborted) {
        reject(new DapiError("canceled", "Download canceled."));
      } else if (code === 0) {
        resolve({ paths: out.split("\n").map((line) => line.trim()).filter(Boolean) });
      } else {
        const detail = stderr.trim().split("\n").filter((l) => l.startsWith("ERROR")).pop();
        reject(new Error(detail ?? `yt-dlp exited with code ${code}.`));
      }
    });
  });
};
