/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { COLOR_MODE_STORAGE_KEY } from "@kobalte/core";

import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";

export type ThemePreference = "light" | "dark" | "system";

/** What the user picked in the theme menu, which Kobalte keeps in localStorage. */
export function storedThemePreference(): ThemePreference | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // ignore storage access errors and fall back to resolved color mode
  }

  return undefined;
}

/**
 * Tells the Windows desktop build which theme the app shows, so the native
 * window controls and the Mica backdrop match it. Called when the resolved
 * mode changes and when the preference does: going from "dark" to "system" on
 * a dark OS changes only the latter.
 */
export function syncWindowColorMode(mode: "light" | "dark"): void {
  if (window.desktop?.platform !== "win32") return;
  mainBridge.call(MAIN_CHANNELS.WINDOW_SET_COLOR_MODE, {
    mode,
    preference: storedThemePreference() ?? mode,
  });
}
