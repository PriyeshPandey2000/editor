/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { skillPrompt, skills } from "./docs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Serves each skill as an MCP prompt named after it. Clients show a server's
 * prompts as slash commands under its name — `/diffusion:editor`,
 * `/diffusion:watch` — and running one puts the skill page into the
 * conversation as a user message: loaded by the client, not left to the
 * model to go and read.
 */
export function servePrompts(session: McpServer, docsDir: string | null): void {
  for (const skill of skills(docsDir)) {
    session.registerPrompt(skill.name, { title: skill.name, description: skill.description }, () => ({
      description: skill.description,
      messages: [{ role: "user", content: { type: "text", text: skillPrompt(skill) } }],
    }));
  }
}
