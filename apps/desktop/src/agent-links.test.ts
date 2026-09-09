/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { AGENTS, agentLink, findAgent, pickVariant } from "./agent-links";

const agent = (id: string) => {
  const found = findAgent(id);
  if (!found) throw new Error(`no agent ${id}`);
  return found;
};

/** The agent's link through one named app, as if only that one were installed. */
const link = (
  id: string,
  variantId: string,
  prompt: string,
  folder: string | null = "/Users/x/Movies/My Film",
) => {
  const target = agent(id);
  const variant = pickVariant(target, (entry) => entry.id === variantId);
  if (!variant) throw new Error(`no variant ${variantId}`);
  return agentLink(target, variant, { prompt, folder });
};

describe("agentLink", () => {
  it("opens Claude in the desktop app's Code tab with q and folder", () => {
    expect(link("claude", "claude-desktop", "cut the intro")).toBe(
      "claude://code/new?q=cut%20the%20intro&folder=%2FUsers%2Fx%2FMovies%2FMy%20Film",
    );
  });

  it("falls back to the CLI handler, which takes the folder as cwd", () => {
    expect(link("claude", "claude-code", "cut the intro")).toBe(
      "claude-cli://open?cwd=%2FUsers%2Fx%2FMovies%2FMy%20Film&q=cut%20the%20intro",
    );
  });

  it("prefers the desktop app when both are there", () => {
    expect(pickVariant(agent("claude"), () => true)?.id).toBe("claude-desktop");
  });

  it("gives Codex prompt and path", () => {
    expect(link("codex", "codex", "cut the intro")).toBe(
      "codex://new?prompt=cut%20the%20intro&path=%2FUsers%2Fx%2FMovies%2FMy%20Film",
    );
  });

  it("gives Conductor its params without a query string", () => {
    expect(link("conductor", "conductor", "cut the intro")).toBe(
      "conductor://prompt=cut%20the%20intro&path=%2FUsers%2Fx%2FMovies%2FMy%20Film",
    );
  });

  it("names the folder in the prompt for agents whose link cannot carry one", () => {
    expect(link("cursor", "cursor", "cut the intro")).toBe(
      "cursor://anysphere.cursor-deeplink/prompt?text=Working%20directory%3A%20%2FUsers%2Fx%2FMovies%2FMy%20Film%0A%0Acut%20the%20intro",
    );
  });

  it("drops the params it has no value for", () => {
    expect(link("claude", "claude-code", "hello", null)).toBe(
      "claude-cli://open?q=hello",
    );
    expect(link("codex", "codex", "", null)).toBe("codex://new");
  });

  it("keeps line breaks and specials out of the query string", () => {
    expect(link("claude", "claude-code", "a&b\nc=d?e#f", null)).toBe(
      "claude-cli://open?q=a%26b%0Ac%3Dd%3Fe%23f",
    );
  });

  it("caps the prompt at what the shortest link accepts", () => {
    const url = new URL(link("claude", "claude-code", "x".repeat(6000), null));
    expect(url.searchParams.get("q")).toHaveLength(5000);
  });

  it("counts the folder line against that cap", () => {
    const url = new URL(link("cursor", "cursor", "x".repeat(6000)));
    expect(url.searchParams.get("text")).toHaveLength(5000);
  });

  it("gives every agent a unique id and every variant at least one marker", () => {
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
    for (const a of AGENTS) {
      expect(a.variants.length).toBeGreaterThan(0);
      for (const variant of a.variants)
        expect(variant.markers.length).toBeGreaterThan(0);
    }
  });
});
