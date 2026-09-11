/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "@diffusionstudio/dapi";
import { MCP_HOST, MCP_PATH, MCP_PORT, SOCKET_PATH, SocketTransport } from "@diffusionstudio/dapi/socket";
import { mainHandlers } from "./handlers";
import { DapiHttpServer } from "./http";
import { instructions, registerPrompts } from "./docs";
import { present, toCallToolResult, toErrorResult } from "./present";
import { RendererCalls } from "./renderer-calls";

import type { Server, Socket } from "node:net";
import type { GenericTool, LogEntry, ToolName } from "@diffusionstudio/dapi";
import type { MainContext, MainToolName } from "./handler";

/**
 * The name the server introduces itself with, and so the namespace an agent
 * shows us under: `mcp__diffusion__<tool>` and `/diffusion:<prompt>`. The
 * same word as our URL scheme, and not `dapi`, which is the CLI.
 */
const SERVER_NAME = "diffusion";

export type DapiServerDeps = {
  version: string;
  /** The app's console buffer, for `logs` and `report`. */
  logs(): LogEntry[];
  /** Called once, on the first connection: an agent is driving, so the UI may step back. */
  onFirstConnection(): void;
  /** The staged docs: INSTRUCTIONS.md and their path for every session, the skill pages as prompts. Null when not staged. */
  docsDir: string | null;
};

/**
 * The app's MCP server, on two transports over one catalog: Streamable HTTP
 * on a fixed loopback port, which agents register by URL, and the local
 * socket the `dapi` CLI uses (and `dapi mcp` proxies for agents that only
 * speak stdio). Each connection gets its own MCP session. Main-process tools
 * run here; renderer tools are forwarded over IPC and their results
 * presented (files written, small images inlined) before they go back out.
 */
export class DapiServer {
  private readonly deps: DapiServerDeps;
  private readonly renderer = new RendererCalls();
  private readonly sessions = new Set<McpServer>();
  private readonly http: DapiHttpServer;
  private server: Server | null = null;
  private connected = false;
  private instructionsText: string | null = null;
  private httpReady: Promise<boolean> = Promise.resolve(false);

  constructor(deps: DapiServerDeps) {
    this.deps = deps;
    for (const tool of tools) {
      if (tool.environment === "main" && !(tool.name in mainHandlers)) {
        throw new Error(`Main-process tool "${tool.name}" has no handler`);
      }
    }
    this.http = new DapiHttpServer({
      host: MCP_HOST,
      port: MCP_PORT,
      path: MCP_PATH,
      createSession: () => this.createSession(),
      onFirstConnection: () => this.firstConnection(),
    });
  }

  /** The URL agents register. */
  get url(): string {
    return this.http.url;
  }

  start(): void {
    removeStaleSocket();
    this.renderer.start();
    this.server = createServer((socket) => void this.accept(socket));
    this.server.on("error", (error) => console.error("[dapi] server error:", error));
    this.server.listen(SOCKET_PATH, () => {
      // Linux shares /tmp between users; the socket file's mode is the auth.
      if (process.platform !== "win32") chmodSync(SOCKET_PATH, 0o600);
    });
    // A taken port is the one way this fails; the socket keeps the CLI and
    // `dapi mcp` working meanwhile, so it is logged, not fatal.
    this.httpReady = this.http.start().then(
      () => true,
      (error: Error) => {
        console.error(`[dapi] cannot serve MCP at ${this.url}: ${error.message}`);
        return false;
      },
    );
  }

  /** The HTTP URL once it is being served; null when the port could not be bound. */
  async mcpUrl(): Promise<string | null> {
    return (await this.httpReady) ? this.url : null;
  }

  stop(): void {
    this.http.stop();
    for (const session of this.sessions) void session.close();
    this.sessions.clear();
    this.server?.close();
    this.server = null;
    removeStaleSocket();
  }

  private firstConnection(): void {
    if (this.connected) return;
    this.connected = true;
    this.deps.onFirstConnection();
  }

  private async accept(socket: Socket): Promise<void> {
    this.firstConnection();
    const session = this.createSession();
    this.sessions.add(session);
    session.server.onclose = () => this.sessions.delete(session);
    try {
      await session.connect(new SocketTransport(socket));
    } catch (error) {
      console.error("[dapi] session failed to start:", error);
      this.sessions.delete(session);
      socket.destroy();
    }
  }

  /** One MCP server over the whole catalog, plus the skills as prompts. The docs are plain files; the instructions say where. */
  private createSession(): McpServer {
    this.instructionsText ??= instructions(this.deps.docsDir);
    // `name` is the machine identity, and matches the key we write into agent
    // configs; `title` is what a client shows a person.
    const session = new McpServer({ name: SERVER_NAME, title: "Diffusion Studio", version: this.deps.version }, { instructions: this.instructionsText });
    for (const tool of tools) this.register(session, tool);
    registerPrompts(session, this.deps.docsDir);
    return session;
  }

  private register(session: McpServer, tool: GenericTool): void {
    session.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output },
      async (args, extra) => {
        try {
          const result =
            tool.environment === "main"
              ? await this.runInMain(tool.name as MainToolName, args, extra.signal)
              : await this.renderer.call(tool.name, args, extra.signal);
          return toCallToolResult(await present(tool.name as ToolName, args, result));
        } catch (error) {
          return toErrorResult(error);
        }
      },
    );
  }

  private runInMain(name: MainToolName, args: unknown, signal: AbortSignal): Promise<unknown> {
    const ctx: MainContext = { signal, logs: this.deps.logs, version: this.deps.version };
    // Each handler takes its own parsed args; the map's union type cannot
    // express that pairing, so the call site widens.
    return (mainHandlers[name] as (args: unknown, ctx: MainContext) => Promise<unknown>)(args, ctx);
  }
}

/**
 * A socket file left by a previous run (Unix). Safe to remove because the
 * single-instance lock guarantees no other instance of ours is running.
 */
function removeStaleSocket(): void {
  try {
    if (process.platform !== "win32" && existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {
    // Best-effort.
  }
}
