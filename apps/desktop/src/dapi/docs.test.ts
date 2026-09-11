/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instructions, registerPrompts, SKILLS } from "./docs";

// The docs in miniature, laid out like the repo's `docs/`.
const root = mkdtempSync(join(tmpdir(), "dapi-docs-"));
const docsDir = join(root, "docs");
const repoDocs = join(__dirname, "..", "..", "..", "..", "docs");

beforeAll(() => {
  mkdirSync(join(docsDir, "skills"), { recursive: true });
  writeFileSync(join(docsDir, "INSTRUCTIONS.md"), "Diffusion Studio is running.\n");
  writeFileSync(join(docsDir, "skills", "editor.md"), "# Editing\n\nHow to edit.\n");
  writeFileSync(join(docsDir, "skills", "watch.md"), "# Watching\n\nHow to watch.\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function connect(dir: string | null): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" }, { instructions: instructions(dir) });
  registerPrompts(server, dir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("instructions", () => {
  it("is INSTRUCTIONS.md followed by where the docs sit on disk", () => {
    const text = instructions(docsDir);
    expect(text.startsWith("Diffusion Studio is running.")).toBe(true);
    expect(text).toContain(`The docs are the files at \`${docsDir}\``);
  });

  it("lists the skills, marking the default, with both ways to pull one in", () => {
    const text = instructions(docsDir);
    expect(text).toContain("`editor` (the default) —");
    expect(text).toContain(`Pull it in with the \`editor\` prompt, or read \`${join(docsDir, "skills", "editor.md")}\`.`);
    expect(text).toContain("`watch` —");
    expect(text).not.toContain("`watch` (the default)");
  });

  it("falls back to a one-liner when nothing is staged", () => {
    const text = instructions(null);
    expect(text).toContain("The tools are the whole API");
    expect(text).not.toContain("skills/editor.md");
  });

  it("builds from the repo's own docs without broken instructions", () => {
    if (!existsSync(repoDocs)) return;
    const text = instructions(repoDocs);
    expect(text).toContain(join(repoDocs, "skills", "editor.md"));
    expect(text).not.toContain("dapi://");
    expect(text).not.toContain("\\`");
  });
});

describe("prompts", () => {
  it("offers one prompt per skill, described the way the instructions describe it", async () => {
    const client = await connect(docsDir);
    const prompts = (await client.listPrompts()).prompts;
    expect(prompts.map((p) => p.name).sort()).toEqual(["editor", "watch"]);
    for (const skill of SKILLS) {
      expect(prompts.find((p) => p.name === skill.name)?.description).toBe(skill.description);
    }
    await client.close();
  });

  it("returns the page as the prompt, with the coda that says what to do with it", async () => {
    const client = await connect(docsDir);
    const result = await client.getPrompt({ name: "editor" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const text = (result.messages[0].content as { text: string }).text;
    expect(text.startsWith("# Editing")).toBe(true);
    expect(text).toContain("ask them what they want to make");
    await client.close();
  });

  it("has no prompts when nothing is staged", async () => {
    const client = await connect(null);
    await expect(client.listPrompts()).rejects.toThrow();
    await client.close();
  });

  it("skips a skill whose page the staged tree does not carry", async () => {
    const bare = join(root, "bare");
    mkdirSync(join(bare, "skills"), { recursive: true });
    writeFileSync(join(bare, "skills", "editor.md"), "# Editing\n");
    const client = await connect(bare);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["editor"]);
    await client.close();
  });

  it("has a page in the repo's own docs for every skill in the table", () => {
    if (!existsSync(repoDocs)) return;
    expect(SKILLS.map((s) => s.name)).toEqual(["editor", "watch"]);
    expect(SKILLS.filter((s) => s.default)).toHaveLength(1);
    for (const skill of SKILLS) expect(existsSync(join(repoDocs, skill.page))).toBe(true);
  });
});
