/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

export type Skill = {
  name: string;
  /** The page carrying the guidance, relative to the docs. */
  page: string;
  description: string;
  /** The skill to reach for when the user has not pointed at one. Exactly one. */
  default?: boolean;
};

/**
 * What the server offers besides the tools. Each entry is both a line in the
 * instructions every session receives and a prompt (`/diffusion:editor`), so
 * adding a skill is adding a row here and its page under `docs/skills/`.
 * Editing is the default; watching is the one you ask for.
 */
export const SKILLS: readonly Skill[] = [
  {
    name: "editor",
    page: "skills/editor.md",
    default: true,
    description:
      "Understand, generate, and edit footage with Diffusion Studio: analyze video/audio/images, generate them with AI, and compose video compositions. Use for any media analysis, media generation, or video editing task.",
  },
  {
    name: "watch",
    page: "skills/watch.md",
    description:
      "Watch and understand footage with Diffusion Studio: answer questions about a video or audio file, summarize it, find scenes and moments, pull quotes, and describe what happens and when. Use whenever the user asks what's in a piece of footage, wants a summary or recap, wants to locate a moment, or needs a claim about a video or audio file checked.",
  },
];

const FALLBACK_INSTRUCTIONS =
  "Diffusion Studio, a video editor, is running on this machine and you are connected to it. The tools are the whole API; their descriptions are authoritative.";

/**
 * The text every client gets on connect: INSTRUCTIONS.md from the docs, then
 * where the docs sit on disk, then the skills. The docs are plain files, read
 * with whatever file tools the agent has; this path is how it finds them.
 */
export function instructions(docsDir: string | null): string {
  const text = docsDir ? readText(join(docsDir, INSTRUCTIONS_FILE)) : null;
  const parts = [text?.trim() || FALLBACK_INSTRUCTIONS];
  if (docsDir) {
    parts.push(
      `The docs are the files at \`${docsDir}\`: the tool and JSX reference, guides, runnable examples, and the brand kit (fonts, imagery, components to copy). They belong to the app; read them, never edit them.`,
    );
    parts.push(skillList(docsDir));
  }
  return parts.join("\n\n");
}

/**
 * The skills as the instructions present them: what each is for, which to
 * reach for by default, and both ways to pull one in — the prompt, for agents
 * that list them, and the page on disk, for the ones that do not.
 */
function skillList(docsDir: string): string {
  const lines = SKILLS.map(
    (skill) =>
      `- \`${skill.name}\`${skill.default ? " (the default)" : ""} — ${skill.description} Pull it in with the \`${skill.name}\` prompt, or read \`${pagePath(docsDir, skill)}\`.`,
  );
  return ["Before starting on the work itself, pull in the skill that covers it:", ...lines].join("\n");
}

/**
 * One prompt per skill, named as the table names it, so an agent that lists a
 * server's prompts offers `/diffusion:editor` and `/diffusion:watch` beside
 * its own commands. The page is read at call time, so edits show up live.
 */
export function registerPrompts(session: McpServer, docsDir: string | null): void {
  if (!docsDir) return;
  for (const skill of SKILLS) {
    const path = pagePath(docsDir, skill);
    if (!existsSync(path)) continue; // a page the staged tree does not carry
    session.registerPrompt(skill.name, { title: skill.name, description: skill.description }, async () => ({
      messages: [{ role: "user", content: { type: "text", text: `${await readFile(path, "utf8")}\n${PROMPT_CODA}` } }],
    }));
  }
}

// A prompt arrives as a user turn, so the page needs a closing line saying
// what to do with guidance that turned up without a request attached to it.
const PROMPT_CODA =
  "\nThe guidance above is in effect for the rest of this conversation. Apply it to what the user asked for; if they have not asked for anything yet, ask them what they want to make.";

function pagePath(docsDir: string, skill: Skill): string {
  return join(docsDir, ...skill.page.split("/"));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
