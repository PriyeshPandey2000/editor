/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the host asks of a harness, and what every adapter has in common:
// the question flow, the item ids, and the truncation of tool output.

import { randomUUID } from "node:crypto";

import type {
  ChatEvent,
  HarnessId,
  HarnessInfo,
  Item,
  PendingRequest,
  Question,
  RequestResponse,
  TurnStatus,
} from "../protocol";
import type { HostEnv } from "./env";

export type ResumeCursor = { claude: { sessionId: string } } | { codex: { threadId: string } };

export type McpConfig = { name: "diffusion"; url: string };

export type Emit = (event: ChatEvent) => void;

export type OpenOptions = {
  cwd: string;
  model: string;
  resume?: ResumeCursor;
  mcp: McpConfig | null;
  instructions?: string;
  env: HostEnv;
  /** The first turn's emitter: for notices about how the session came up. */
  emit: Emit;
};

/** How a turn ended. The host turns it into `turn.completed`. */
export type TurnOutcome = { status: TurnStatus; error?: string };

export interface HarnessSession {
  /** Persisted after every turn; what the next `open` resumes from. */
  readonly resume: ResumeCursor;
  /** Runs one turn. Resolves when the turn has ended, whatever the outcome. */
  send(text: string, model: string, emit: Emit): Promise<TurnOutcome>;
  /** Answers (or skips, or cancels) a pending question. */
  respond(requestId: string, response: RequestResponse): void;
  /** Ends the running turn. Resolves once `send` has. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface Harness {
  readonly id: HarnessId;
  probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo>;
  open(options: OpenOptions): Promise<HarnessSession>;
}

/** Tool output kept per item, so a transcript never carries a whole file. */
export const DETAIL_MAX = 2048;

export function truncateDetail(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= DETAIL_MAX) return text;
  return text.slice(0, DETAIL_MAX) + "…";
}

export function newItemId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

/** A one-line summary of a tool's input, for the tool row. */
export function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return firstLine(input);
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  try {
    return firstLine(JSON.stringify(input));
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 160 ? line.slice(0, 159) + "…" : line;
}

/** `mcp__diffusion__capture` → "capture"; anything else stays. */
export function toolTitle(name: string): string {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return mcp ? mcp[1]! : name;
}

/**
 * The question flow every adapter shares. `open` emits the request and
 * hands back a promise the host settles through `respond`; settling emits
 * `request.resolved` and records what was decided as a `question` item.
 */
export class QuestionBox {
  private readonly emit: Emit;
  private readonly open = new Map<string, { request: PendingRequest; resolve(response: RequestResponse): void }>();

  constructor(emit: Emit) {
    this.emit = emit;
  }

  get size(): number {
    return this.open.size;
  }

  ask(questions: Question[], signal?: AbortSignal): Promise<RequestResponse> {
    const request: PendingRequest = { id: newItemId("q"), type: "question", questions };
    return new Promise<RequestResponse>((resolve) => {
      this.open.set(request.id, { request, resolve });
      this.emit({ type: "request.opened", request });
      signal?.addEventListener("abort", () => this.settle(request.id, "cancel"), { once: true });
    });
  }

  settle(requestId: string, response: RequestResponse): boolean {
    const entry = this.open.get(requestId);
    if (!entry) return false;
    this.open.delete(requestId);
    const outcome = response === "cancel" ? "cancel" : response === "skip" ? "skipped" : "answered";
    this.emit({ type: "request.resolved", requestId, outcome });
    if (response !== "cancel") {
      const item: Item = {
        id: requestId,
        kind: "question",
        questions: entry.request.questions,
        answers: response === "skip" ? null : response.answers,
      };
      this.emit({ type: "item.completed", item });
    }
    entry.resolve(response);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.open.keys()]) this.settle(id, "cancel");
  }
}

/** The instructions every chat appends, with the project folder filled in. */
export function chatInstructions(cwd: string, custom?: string): string {
  const base =
    `You are running in Diffusion Studio's chat panel. The open project is at \`${cwd}\`. ` +
    "The `diffusion` MCP tools act on it live — use `capture`/`check` to verify edits. " +
    "Before deleting or overwriting source media, or acting outside this folder, ask first with a question.";
  return custom ? `${base}\n\n${custom}` : base;
}

/** The text a harness gets: the message, then the attached paths, one per line. */
export function withAttachments(text: string, attachments: string[] | undefined): string {
  if (!attachments || attachments.length === 0) return text;
  return `${text}\n\nAttached files and folders:\n${attachments.join("\n")}`;
}
