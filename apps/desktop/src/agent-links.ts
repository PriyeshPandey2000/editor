/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** What the user is handing over: the prompt, and the folder to work in. */
export type AgentLaunch = {
  prompt: string;
  /** Absolute path of the project folder, or null when there is none. */
  folder: string | null;
};

/**
 * One app that can take an agent's link. An agent is usually a single app,
 * but Claude is reachable through two — the desktop app and the CLI's URL
 * handler — and the user does not care which is behind the button.
 */
export type AgentVariant = {
  /** Which app this is, for the tests; the renderer only sees the agent id. */
  id: string;
  /**
   * Paths whose presence means this app can take a link on this machine:
   * absolute, or home-relative when they do not start with a slash. A
   * trailing `*` matches any entry of the parent directory with that prefix,
   * which is how a versioned extension folder is found. Any one is enough.
   */
  markers: readonly string[];
  /**
   * Further paths, one of which must exist as well. For apps that are the
   * whole condition on their own this is unset; an editor plus the extension
   * that registers its handler needs both, and an extension folder left
   * behind by an uninstalled editor is exactly the case that would otherwise
   * offer a link nothing answers.
   */
  requires?: readonly string[];
  link(launch: AgentLaunch): string;
};

export type AgentTarget = {
  /** Stable id — what the renderer remembers the user's choice as. */
  id: string;
  label: string;
  /**
   * Whether the link can name the working directory itself. The rest get the
   * folder as a line of the prompt instead — worse, but not silently wrong.
   */
  folder: boolean;
  /** The apps that can take this agent's link, best first. */
  variants: readonly AgentVariant[];
};

/** The non-empty params as one URL-encoded `a=1&b=2`. */
function params(values: Record<string, string | null>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

/** `base` with the non-empty params appended as a query string. */
function query(base: string, values: Record<string, string | null>): string {
  const search = params(values);
  return search ? `${base}?${search}` : base;
}

// Ordered by how well the link fits what this app hands over — a working
// directory and a prompt — so the first available one is the default pick.
export const AGENTS: readonly AgentTarget[] = [
  {
    id: "claude",
    label: "Claude Code",
    folder: true,
    variants: [
      {
        id: "claude-desktop",
        markers: ["/Applications/Claude.app", "Applications/Claude.app"],
        link: ({ prompt, folder }) =>
          query("claude://code/new", { q: prompt, folder }),
      },
      {
        id: "claude-code",
        markers: [
          "Applications/Claude Code URL Handler.app",
          ".local/share/applications/claude-code-url-handler.desktop",
        ],
        link: ({ prompt, folder }) =>
          query("claude-cli://open", { cwd: folder, q: prompt }),
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    folder: true,
    variants: [
      {
        id: "codex",
        // Codex ships standalone and inside the ChatGPT desktop app, which
        // keeps the `codex://` scheme.
        markers: [
          "/Applications/Codex.app",
          "Applications/Codex.app",
          "/Applications/ChatGPT.app",
        ],
        link: ({ prompt, folder }) =>
          query("codex://new", { prompt, path: folder }),
      },
    ],
  },
  {
    id: "conductor",
    label: "Conductor",
    folder: true,
    variants: [
      {
        id: "conductor",
        markers: ["/Applications/Conductor.app", "Applications/Conductor.app"],
        // Not a query string: Conductor reads its params straight off the
        // scheme, with no host and no `?` in front of them.
        link: ({ prompt, folder }) =>
          `conductor://${params({ prompt, path: folder })}`,
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    folder: false,
    variants: [
      {
        id: "cursor",
        markers: ["/Applications/Cursor.app", "Applications/Cursor.app"],
        link: ({ prompt }) =>
          query("cursor://anysphere.cursor-deeplink/prompt", { text: prompt }),
      },
    ],
  },
  {
    id: "vscode",
    label: "VS Code",
    folder: false,
    variants: [
      {
        id: "vscode",
        markers: [".vscode/extensions/anthropic.claude-code-*"],
        requires: [
          "/Applications/Visual Studio Code.app",
          "Applications/Visual Studio Code.app",
        ],
        link: ({ prompt }) =>
          query("vscode://anthropic.claude-code/open", { prompt }),
      },
    ],
  },
];

/**
 * The shortest cap any of these links puts on its prompt (Claude Code's), so
 * one length rule covers them all. A prompt this long is already far past
 * what the composer is for.
 */
const MAX_PROMPT = 5000;

/** The line naming the folder for agents whose link cannot carry one. */
const folderLine = (folder: string): string =>
  `Working directory: ${folder}\n\n`;

/** The first variant `available` accepts, or null when none is reachable. */
export const pickVariant = (
  agent: AgentTarget,
  available: (variant: AgentVariant) => boolean,
): AgentVariant | null => agent.variants.find(available) ?? null;

export function agentLink(
  agent: AgentTarget,
  variant: AgentVariant,
  launch: AgentLaunch,
): string {
  const prefix =
    !agent.folder && launch.folder ? folderLine(launch.folder) : "";
  return variant.link({
    prompt: `${prefix}${launch.prompt}`.slice(0, MAX_PROMPT),
    folder: agent.folder ? launch.folder : null,
  });
}

export const findAgent = (id: string): AgentTarget | undefined =>
  AGENTS.find((agent) => agent.id === id);
