/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, dialog, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { CLI_LINK_PATH } from "./cli-install";
import { registeredAgents, unregisterMcp } from "./mcp-install";
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
  const { mcp, cli, skills } = await ensureSetup("force");

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
  refreshAppMenu();
}

// The inverse of the item above: takes the app's MCP entry back out of every
// agent config that has one. Reversible from the same menu, so a plain
// confirm is enough; the item is only shown while there is something to undo.
async function disconnectAgentsFromMenu() {
  const agents = registeredAgents();
  if (agents.length === 0) {
    refreshAppMenu();
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Disconnect your agents?",
    detail: [
      `Diffusion Studio will be removed from the MCP configuration of ${agents.join(", ")}. Restart the agent to pick it up.`,
      "The dapi command line tool stays installed. Sending a prompt to an agent from the dashboard connects it again.",
    ].join("\n\n"),
    buttons: ["Disconnect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const result = unregisterMcp();
  refreshAppMenu();

  if (result.agents.length === 0) {
    await dialog.showMessageBox({
      type: "error",
      message: "Could not disconnect your agents.",
      detail: result.failures.join("\n"),
    });
    return;
  }

  await dialog.showMessageBox({
    type: result.failures.length > 0 ? "warning" : "info",
    message: "Your agents are disconnected.",
    detail: [
      `Disconnected: ${result.agents.join(", ")}. Restart the agent to pick it up.`,
      result.failures.length > 0 ? `Could not update:\n${result.failures.join("\n")}` : null,
    ].filter((line): line is string => line !== null).join("\n\n"),
  });
}

const DISCONNECT_ITEM_ID = "disconnect-agents";

/**
 * Re-reads the agent configs and shows or hides "Disconnect Agents…" to
 * match. Called after anything that writes those configs — the two menu
 * items, and setup runs the renderer asks for — so the menu never offers to
 * undo a connection that is not there.
 */
export function refreshAppMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById(DISCONNECT_ITEM_ID);
  if (item) item.visible = registeredAgents().length > 0;
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
        {
          id: DISCONNECT_ITEM_ID,
          label: "Disconnect Agents…",
          visible: registeredAgents().length > 0,
          click: disconnectAgentsFromMenu,
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
