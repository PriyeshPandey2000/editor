/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

const FALLBACK_INSTRUCTIONS =
  "Diffusion Studio, a video editor, is running on this machine and you are connected to it. The tools are the whole API; their descriptions are authoritative.";

/**
 * The text every client gets on connect: INSTRUCTIONS.md from the docs, then
 * where the docs sit on disk. The page names the skills and everything else
 * it wants read — adding one is editing that file, not this one; the paths in
 * it are relative to the docs, and the sentence below is what anchors them.
 */
export function instructions(docsDir: string | null): string {
  const text = docsDir ? readText(join(docsDir, INSTRUCTIONS_FILE)) : null;
  const parts = [text?.trim() || FALLBACK_INSTRUCTIONS];
  if (docsDir) {
    parts.push(
      `The docs, including every page named above, are the files at \`${docsDir}\`: the skills, the tool and JSX reference, guides, runnable examples, and the brand kit (fonts, imagery, components to copy). They belong to the app; read them, never edit them.`,
    );
  }
  return parts.join("\n\n");
}

/** A skill page INSTRUCTIONS.md names: `skills/<name>.md`, and the description after the dash. */
export type Skill = { name: string; description: string; path: string };

const SKILL_ENTRY = /^- `skills\/([\w-]+)\.md`[^—\n]*— (.+)$/gm;

/**
 * The skills, read off INSTRUCTIONS.md's list, so the page stays the one
 * place a skill is declared. An entry whose page is missing is dropped.
 */
export function skills(docsDir: string | null): Skill[] {
  const text = docsDir ? readText(join(docsDir, INSTRUCTIONS_FILE)) : null;
  if (!docsDir || !text) return [];
  return [...text.matchAll(SKILL_ENTRY)]
    .map((m) => ({ name: m[1], description: m[2].trim(), path: join(docsDir, "skills", `${m[1]}.md`) }))
    .filter((skill) => readText(skill.path) !== null);
}

/**
 * What invoking a skill puts in the conversation: the page itself, not a
 * request to go read it, so the skill is loaded whatever the model decides.
 * The path anchors the page's relative links.
 */
export function skillPrompt(skill: Skill): string {
  const page = readText(skill.path)?.trim() ?? "";
  return `Follow this Diffusion Studio skill for the rest of the session. It is the page \`${skill.path}\`, already read in full below; its relative links resolve from there.\n\n${page}`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
