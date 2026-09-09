/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, dialog, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { CLI_LINK_PATH } from "./cli-install";
import { ensureSetup } from "./setup";

import type { CliSetupResult } from "./main-channels";

/** The line the dialog gets about the CLI, or null when there is nothing to say. */
function cliDetail(result: CliSetupResult): string | null {
  switch (result.status) {
    case "installed":
      return `The dapi command line tool is linked at ${CLI_LINK_PATH}. Run "dapi --help" to get started.`;
    case "present":
      return `The dapi command line tool is already installed at ${CLI_LINK_PATH}.`;
    case "cancelled":
      return "The dapi command line tool was not installed — the admin prompt was dismissed.";
    case "error":
      return `The dapi command line tool could not be installed: ${result.error}`;
    case "skipped":
      return null;
  }
}

// The menu item behind everything in `setup.ts`. Picking it is asking for
// the CLI by name, so this is the one caller that asks for the password
// again after a previous refusal.
async function connectAgentsFromMenu() {
  const { mcp, cli, skills } = await ensureSetup({ cli: "force" });

  if (mcp.status === "error") {
    await dialog.showMessageBox({
      type: "error",
      message: "Could not connect your agents.",
      detail: mcp.error,
    });
    return;
  }

  const detail = [
    `Connected: ${mcp.agents.join(", ")}. Restart the agent to pick it up.`,
    `Any other agent can use the URL ${mcp.url}${mcp.command ? `, or run "${mcp.command}" over stdio` : ""}.`,
    cliDetail(cli),
    skills.length > 0 ? `Removed ${skills.length} outdated skill folder${skills.length > 1 ? "s" : ""}; the same guidance now comes from the MCP server.` : null,
  ].filter((line): line is string => line !== null);

  await dialog.showMessageBox({
    type: "info",
    message: "Your agents are connected.",
    detail: detail.join("\n\n"),
  });
}

export function setupAppMenu() {
  if (process.platform !== "darwin") return;

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Connect Agents…",
          click: connectAgentsFromMenu,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
