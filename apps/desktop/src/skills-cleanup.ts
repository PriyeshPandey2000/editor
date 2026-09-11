/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Removes the skill directories older builds planted in agents' skill
// folders. The guidance they carried is served over MCP now (see
// `dapi/docs.ts`), so a copy on disk is a second, staler answer to the
// same question — and it points at a `dapi` binary that may no longer be
// where it was linked.
//
// Two kinds were ever installed: real directories copied by the skills CLI
// (`npx skills add diffusionstudio/skills`), and symlinks into the app
// bundle's staged copy. Both go, and nothing else does: a directory has to
// name itself as ours before it is touched.

import { lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The skills we shipped, by the directory name they were installed under. */
const LEGACY_SKILLS = ["editor", "watch"];

/** Home-relative folders of the agents older builds installed skills for. */
const AGENT_DIRS = [".claude", ".codex", ".cursor", ".gemini", ".codeium/windsurf"];

/**
 * Where an agent keeps its global skills: `skills/` inside its folder —
 * `~/.claude/skills`, `~/.codex/skills`, and so on.
 */
const skillsDirs = (): string[] =>
  AGENT_DIRS.map((dir) => join(homedir(), dir, "skills"));

/** The link's target, or null when `path` is missing or not a symlink. */
function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the skill at `path` is one of ours. A symlink into a Diffusion
 * Studio bundle is ours even when it dangles — that is the case the app
 * moving leaves behind. Anything else has to say so in its own SKILL.md,
 * which is what keeps a user's unrelated `editor` skill safe.
 */
function isOurs(path: string, name: string): boolean {
  const target = linkTarget(path);
  if (target?.includes("Diffusion Studio") || target?.includes("/AppTranslocation/")) return true;
  try {
    const text = readFileSync(join(path, "SKILL.md"), "utf8");
    return text.includes(`name: ${name}`) && text.includes("Diffusion Studio");
  } catch {
    return false; // no SKILL.md to vouch for it
  }
}

/**
 * Removes every stale skill of ours from the agents we support, and returns
 * the paths it removed. Best effort: a skill it cannot read or delete is
 * left where it is. Removing a symlink removes the link, never its target.
 */
export function pruneLegacySkills(): string[] {
  const removed: string[] = [];
  for (const dir of skillsDirs()) {
    for (const name of LEGACY_SKILLS) {
      const path = join(dir, name);
      if (!isOurs(path, name)) continue;
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch { /* Ignore errors */ }
    }
  }
  return removed;
}
