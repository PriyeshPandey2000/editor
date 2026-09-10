/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, dialog, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { CLI_LINK_PATH, isCliLinked } from "./cli-install";
import { registeredAgents } from "./mcp-install";
import { disconnectSetup, ensureSetup, setupConnected } from "./setup";

import type { CliUninstallResult } from "./cli-install";
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
}

/** The line the disconnect dialog gets about the CLI, or null when there was nothing to remove. */
function cliRemovalDetail(result: CliUninstallResult): string | null {
  switch (result.status) {
    case "removed":
      return `The dapi command line tool was removed from ${CLI_LINK_PATH}.`;
    case "cancelled":
      return `The dapi command line tool is still at ${CLI_LINK_PATH} — the admin prompt was dismissed.`;
    case "error":
      return `The dapi command line tool could not be removed: ${result.error}`;
    case "absent":
      return null;
  }
}

// The inverse of the item above: takes the app's MCP entry back out of every
// agent config that has one, and the dapi link off PATH. Reversible from the
// same menu, so a plain confirm is enough; the item is only shown while
// there is something to undo.
async function disconnectAgentsFromMenu() {
  const agents = registeredAgents();
  const linked = isCliLinked();
  if (agents.length === 0 && !linked) {
    refreshAppMenu();
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Disconnect your agents?",
    detail: [
      agents.length > 0 ? `Diffusion Studio will be removed from the MCP configuration of ${agents.join(", ")}. Restart the agent to pick it up.` : null,
      linked ? `The dapi command line tool will be removed from ${CLI_LINK_PATH}, which needs your admin password.` : null,
      "Sending a prompt to an agent from the dashboard connects it again.",
    ].filter((line): line is string => line !== null).join("\n\n"),
    buttons: ["Disconnect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const { mcp, cli } = await disconnectSetup();

  const failed = [
    ...mcp.failures,
    cli.status === "error" ? cli.error : null,
  ].filter((line): line is string => line !== null);
  const undone = mcp.agents.length > 0 || cli.status === "removed";

  if (!undone) {
    await dialog.showMessageBox({
      type: cli.status === "cancelled" ? "info" : "error",
      message: "Your agents were not disconnected.",
      detail: [cliRemovalDetail(cli), ...mcp.failures].filter((line): line is string => line !== null).join("\n\n"),
    });
    return;
  }

  await dialog.showMessageBox({
    type: failed.length > 0 || cli.status === "cancelled" ? "warning" : "info",
    message: "Your agents are disconnected.",
    detail: [
      mcp.agents.length > 0 ? `Disconnected: ${mcp.agents.join(", ")}. Restart the agent to pick it up.` : null,
      cliRemovalDetail(cli),
      mcp.failures.length > 0 ? `Could not update:\n${mcp.failures.join("\n")}` : null,
    ].filter((line): line is string => line !== null).join("\n\n"),
  });
}

const DISCONNECT_ITEM_ID = "disconnect-agents";

/**
 * Re-reads what setup left on this machine and shows or hides "Disconnect
 * Agents…" to match. Called after anything that changes it — the two menu
 * items, and setup runs the renderer asks for — so the menu never offers to
 * undo a connection that is not there.
 */
export function refreshAppMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById(DISCONNECT_ITEM_ID);
  if (item) item.visible = setupConnected();
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
          visible: setupConnected(),
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
