/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app } from "electron";
import { join } from "node:path";
import { access, writeFile } from "node:fs/promises";

/**
 * Desktop analytics. The renderer's Umami script never fires inside Electron
 * (its `data-domains` gate does not match the `file://` origin), so main
 * posts events directly to Umami's send API: the renderer's product events
 * arrive over `ANALYTICS_TRACK`, and the install event is sent from here.
 *
 * Install tracking is proxied by the first launch of a packaged build: one
 * event, then a marker file in `userData` to never send it again. Offline
 * first launches retry on the next launch.
 */

const UMAMI_ENDPOINT = "https://cloud.umami.is/api/send";
const UMAMI_WEBSITE_ID = "e898e381-6ce3-4f5f-a485-8327ec9aa88b";
const HOSTNAME = "desktop.diffusion.studio";
const MARKER_FILE = "install-tracked";

// Umami discards events whose User-Agent trips its bot filter, which both
// Node's fetch default and Electron's own UA do — send a plain browser UA
// that still attributes the right OS.
function userAgent(): string {
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

export type AnalyticsEventData = Record<string, string | number | boolean>;

/** Post one event to Umami. Resolves to whether Umami accepted it; never throws. */
async function sendEvent(name: string, url: string, data: AnalyticsEventData): Promise<boolean> {
  try {
    const response = await fetch(UMAMI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
      body: JSON.stringify({
        type: "event",
        payload: { website: UMAMI_WEBSITE_ID, hostname: HOSTNAME, url, name, data },
      }),
    });
    return response.ok;
  } catch {
    // Offline or Umami unreachable.
    return false;
  }
}

/** A product event from the renderer. Dev builds stay out of the numbers. */
export async function trackEvent(name: string, data: AnalyticsEventData = {}): Promise<void> {
  if (!app.isPackaged) return;
  await sendEvent(name, "/desktop", {
    ...data,
    platform: process.platform,
    version: app.getVersion(),
  });
}

export async function trackInstall(): Promise<void> {
  if (!app.isPackaged) return;

  const marker = join(app.getPath("userData"), MARKER_FILE);
  try {
    await access(marker);
    return;
  } catch {
    // No marker yet — this is the first (tracked) launch.
  }

  const sent = await sendEvent("desktop_install", "/desktop/install", {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  });
  // Not sent — retried on the next launch.
  if (sent) await writeFile(marker, new Date().toISOString()).catch(() => {});
}
