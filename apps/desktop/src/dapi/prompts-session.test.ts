/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { servePrompts } from "./prompts-session";

const repoDocs = join(__dirname, "..", "..", "..", "..", "docs");

let client: Client;

beforeAll(async () => {
  const session = new McpServer({ name: "diffusion", version: "0.0.0" });
  servePrompts(session, existsSync(repoDocs) ? repoDocs : null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => client.close());

describe("servePrompts", () => {
  it("lists the skills INSTRUCTIONS.md names, each with its description", async () => {
    if (!existsSync(repoDocs)) return;
    const listed = (await client.listPrompts()).prompts;
    expect(listed.map((prompt) => prompt.name)).toEqual(["editor", "watch"]);
    for (const prompt of listed) expect(prompt.description, prompt.name).toBeTruthy();
    expect(listed[0].description).not.toContain("(the default)");
  });

  it("answers with the skill page itself, anchored to its path", async () => {
    if (!existsSync(repoDocs)) return;
    const path = join(repoDocs, "skills", "watch.md");
    const { messages } = await client.getPrompt({ name: "watch" });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain(`\`${path}\``);
    expect(text).toContain(readFileSync(path, "utf8").trim());
  });
});
