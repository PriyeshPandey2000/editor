/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the app's MCP server with the agents on this machine, one agent
// at a time as the settings page asks: the fixed loopback URL for agents
// that speak HTTP, the bundled `dapi mcp` proxy for the rest. No PATH
// symlink and no admin prompt — that is `cli-install.ts`, for people who
// type `dapi`.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_URL } from "@diffusionstudio/dapi";
import { shimPath } from "./cli-windows";
import {
  AGENT_TARGETS,
  agentTarget,
  needsBinary,
  readServer,
  removeServer,
  runsOurProxy,
  sameCommand,
  upsertServer,
} from "./mcp-config";

import type { AgentPath, AgentTarget, McpServerSpec } from "./mcp-config";
import type { McpAgentStatus, McpApplyRequest, McpApplyResult, McpStatus } from "./main-channels";

// The dev workflow links the workspace build into Homebrew's bin
// (`npm run link` in apps/cli); that is the binary a dev build registers.
const DEV_BINARY = "/opt/homebrew/bin/dapi";

/**
 * The bundled `dapi` binary, or null when none is available (an unstaged dev
 * build). On Windows it is the shim outside the install folder, the one path
 * that survives an update; a packaged app writes it on every launch, so it
 * counts as there even in the moment before that write lands.
 */
export function dapiBinary(): string | null {
  if (process.platform === "win32") {
    const shim = shimPath();
    return app.isPackaged || existsSync(shim) ? shim : null;
  }
  const command = app.isPackaged ? join(process.resourcesPath, "cli", "bin", "dapi") : DEV_BINARY;
  return existsSync(command) ? command : null;
}

function spec(): McpServerSpec {
  const binary = dapiBinary();
  if (!binary) {
    return { url: MCP_URL, command: "", args: [] };
  }
  // A `.cmd` only runs through a shell, and the agents spawn without one.
  if (process.platform === "win32") {
    return { url: MCP_URL, command: "cmd", args: ["/c", binary, "mcp"] };
  }

  return { url: MCP_URL, command: binary, args: ["mcp"] };
}

function resolvePath(location: AgentPath): string {
  if (location.root === "home") {
    return join(homedir(), location.path);
  }
  if (location.root === "appData") {
    return join(app.getPath("appData"), location.path);
  }

  throw new Error(`Unknown agent path root: ${location.root}`);
}

function readConfig(target: AgentTarget): string | null {
  const path = resolvePath(target.config);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeConfig(target: AgentTarget, text: string): void {
  const path = resolvePath(target.config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Why this agent cannot be connected from this build, or null when it can.
 * Only the stdio agents have reasons: a build without the `diffusion` binary has
 * nothing for them to run, and a quarantined first launch runs from a
 * translocated read-only mount whose path won't survive the next launch —
 * registering it would dangle.
 */
function unavailableReason(target: AgentTarget, current: McpServerSpec): string | null {
  if (!needsBinary(target)) return null;
  if (current.command === "") return "Needs the diffusion command line tool, which this build does not include.";
  if (app.isPackaged && current.command.includes("/AppTranslocation/")) {
    return "Move Diffusion Studio to the Applications folder and relaunch it first.";
  }
  return null;
}

function agentStatus(target: AgentTarget, current: McpServerSpec): McpAgentStatus {
  const registered = readServer(readConfig(target), target.format);
  return {
    id: target.id,
    label: target.label,
    detected: existsSync(resolvePath(target.marker)),
    connected: registered !== null,
    config: resolvePath(target.config),
    unavailable: unavailableReason(target, current),
  };
}

/** Every agent we know, with whether it is on this machine and whether its config carries our entry. */
export function mcpStatus(): McpStatus {
  const current = spec();
  return { url: current.url, agents: AGENT_TARGETS.map((target) => agentStatus(target, current)) };
}

/**
 * Writes our entry into the configs of `add` and takes it out of the configs
 * of `remove`, one file at a time, so one unreadable config does not stop
 * the rest. Other servers in the same file are left alone either way.
 */
export function applyMcp(request: McpApplyRequest): McpApplyResult {
  const current = spec();
  const result: McpApplyResult = { added: [], removed: [], failures: [] };

  for (const id of request.add) {
    const target = agentTarget(id);
    const reason = unavailableReason(target, current);
    if (reason) {
      result.failures.push({ id, error: reason });
      continue;
    }
    try {
      writeConfig(target, upsertServer(readConfig(target), target.format, target.entry(current)));
      result.added.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config.path}: ${(e as Error).message}` });
    }
  }

  for (const id of request.remove) {
    const target = agentTarget(id);
    try {
      const next = removeServer(readConfig(target), target.format);
      if (next !== null) writeConfig(target, next);
      result.removed.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config.path}: ${(e as Error).message}` });
    }
  }

  return result;
}

/**
 * Launch-time self-heal for the stdio agents: an entry that still runs the
 * proxy from a bundle that moved (or was translocated when it was written)
 * is rewritten to the binary this build has. Entries the user wrote by hand
 * for something else are left alone.
 */
export function healMcpRegistrations(): void {
  if (!app.isPackaged) return;
  const current = spec();
  if (current.command === "" || current.command.includes("/AppTranslocation/")) return;

  for (const target of AGENT_TARGETS) {
    const text = readConfig(target);
    const registered = readServer(text, target.format);
    if (!registered?.command) continue;
    if (!runsOurProxy(registered)) continue;
    const entry = target.entry(current);
    if (sameCommand(registered, entry)) continue;

    try {
      writeConfig(target, upsertServer(text, target.format, entry));
    } catch {
      // best effort — the settings page remains as a manual fix
    }
  }
}
