/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The row under the last message while a turn runs: a tail-chase loader
// and a muted line saying what the agent is on right now, read off the
// last item. Both harnesses map to the same item model, so the wording is
// the same for Claude Code and Codex.

import "ldrs/tailChase";

import type { Item } from "@diffusionstudio/agent-chat";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "l-tail-chase": { size?: number | string; color?: string; speed?: number | string };
    }
  }
}

/** What the agent is doing, judged by the item the turn is on. */
export function runningLabel(last: Item | undefined): string {
  if (!last) return "Thinking";
  switch (last.kind) {
    case "reasoning":
      return "Thinking";
    case "assistant":
      return "Writing";
    case "tool":
      return last.status === "running" ? toolLabel(last.name, last.title) : "Thinking";
    default:
      return "Thinking";
  }
}

function toolLabel(name: string, title: string): string {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
      return "Reading files";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "fileChange":
      return "Editing files";
    case "Bash":
    case "commandExecution":
      return "Running a command";
    case "WebSearch":
    case "WebFetch":
    case "webSearch":
      return "Searching the web";
    case "Agent":
      return "Delegating";
    default:
      return `Using ${title}`;
  }
}

export function RunningIndicator(props: { last: Item | undefined }) {
  return (
    <div class="flex h-6 items-center gap-2 px-1 text-[11px] text-muted-foreground" role="status" aria-live="polite">
      <l-tail-chase size="15" speed="1.75" color="currentColor" />
      <span>{runningLabel(props.last)}…</span>
    </div>
  );
}
