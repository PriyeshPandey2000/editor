/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The dashboard's landing view: a prompt, the folder it is about, and the
// coding agent it goes to. Submitting does three things in order — connects
// the agents to this app's MCP server if none is connected yet, settles on a
// project folder (a chosen one, a picked folder, or a fresh project under the
// application folder), then opens the agent's own app on that folder with the
// prompt in its composer. The editor follows into the project.
//
// The agent is opened over its deep link, in the foreground, with the prompt
// left unsent: the user sees what is being asked and sends it themselves. See
// `@/lib/agents` and `agent-links.ts` in the desktop app.

import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { isServer } from "solid-js/web";
import { toast } from "somoto";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { projectRoute } from "@/hooks/use-project-route";
import { store } from "@/init";
import { connectAgents, launchAgent, listAgents, type AgentInfo } from "@/lib/agents";
import { track } from "@/lib/analytics";
import { generateProjectName } from "@/lib/db";
import { createStoredSignal } from "@/lib/store";
import {
  createProject,
  ensureProjectsRoot,
  isDesktop,
  listProjects,
  openProjectFolder,
  pickProjectFolder,
  projectKey,
  projectsRoot,
  type ProjectInfo,
} from "@/projects";

import {
  DashboardCardButton,
  DashboardCardMeta,
  DashboardCardPreview,
  DashboardProjectThumbnail,
} from "./shared";
import { formatEditedAt, parseTimestamp } from "./utils";

/**
 * Where the prompt lands: a project chosen from the recents, a folder chosen
 * from the picker — any folder will do, `resolveTarget` makes it a Diffusion
 * Studio project — or, until either is chosen, a fresh project under the
 * application folder.
 */
type PromptTarget =
  | { kind: "new" }
  | { kind: "project"; project: ProjectInfo }
  | { kind: "folder"; dir: string };

/** Cards that fit the one row the design gives recents, the new one included. */
const RECENT_COLUMNS = 5;

/** Recent projects the target menu offers before it gets unwieldy. */
const MENU_PROJECTS = 8;

/** The half of the placeholder that stays put; the rest is typed after it. */
const PROMPT_PREFIX = "Ask Diffusion Studio to";

/** The edits the placeholder types its way through, one line at a time. */
const PROMPT_EXAMPLES = [
  "cut this interview down to 90 seconds",
  "add subtitles to every clip",
  "remove the silences from this recording",
  "grade the beach footage warmer",
  "animate a lower third for each speaker",
  "reframe the edit to 9:16 for social",
  "drop b-roll over the voiceover",
];

/** Milliseconds a typed character, an erased one, and a finished line take. */
const TYPE_MS = 42;
const ERASE_MS = 22;
const HOLD_MS = 2200;

export function DashboardHomeView() {
  const navigate = useNavigate();

  const [prompt, setPrompt] = createSignal("");
  const [target, setTarget] = createSignal<PromptTarget>({ kind: "new" });
  const [selectedProject, setSelectedProject] = createSignal<string | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);

  // Only worth animating while the field is empty — the placeholder is not on
  // screen behind text the user has typed.
  const placeholder = createTypedPlaceholder(() => prompt().length === 0);

  const [projects, { refetch: refetchProjects }] = createResource(
    projectsRoot,
    () => listProjects(),
  );
  const [agents] = createResource(listAgents, { initialValue: [] });

  // The agent outlives the session, so the next prompt goes where the last one
  // did — unless that agent is not installed here, in which case the best one
  // that is becomes what the button shows and what submitting uses.
  const [preferredAgent, setPreferredAgent] = createStoredSignal(
    store.define<string | null>("home.agent", null),
  );

  const agent = createMemo(() => {
    const usable = agents().filter((entry) => entry.available);
    return (
      usable.find((entry) => entry.id === preferredAgent()) ?? usable[0] ?? null
    );
  });

  const recentProjects = createMemo(() =>
    [...(projects() ?? [])].sort(
      (a, b) => parseTimestamp(b.modifiedAt) - parseTimestamp(a.modifiedAt),
    ),
  );

  const targetLabel = () => {
    const current = target();
    if (current.kind === "project") return current.project.displayName;
    if (current.kind === "folder") return folderName(current.dir);
    return "Choose project";
  };

  const canSubmit = () => prompt().trim().length > 0 && !!agent() && !busy();

  const handlePickFolder = async () => {
    try {
      const dir = await pickProjectFolder();
      if (dir) setTarget({ kind: "folder", dir });
    } catch (e) {
      toast.error("Failed to choose folder", {
        description: (e as Error).message,
      });
    }
  };

  /**
   * The folder the agent will work in. A picked folder is opened as a project,
   * which scaffolds an entry into it when it is not one already — so any
   * folder on disk can be the answer, not only a project we made. With none
   * picked, a fresh project under the application folder.
   */
  const resolveTarget = async (): Promise<ProjectInfo | null> => {
    const current = target();
    if (current.kind === "project") return current.project;
    if (current.kind === "folder") return openProjectFolder(current.dir);

    // Waits for the roots to come back from the database, and asks for one
    // when there is none to wait for.
    if (!(await ensureProjectsRoot())) return null;
    return createProject(generateProjectName());
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    if (!isDesktop()) {
      toast.error("Handing a prompt to a coding agent needs the desktop app");
      return;
    }

    const text = prompt().trim();
    const chosen = agent()!;
    setBusy(true);

    try {
      // Before anything else: the agent is no use on this project without the
      // app's MCP server in its config, and it reads that config at startup —
      // so it has to be there before the link opens it.
      await connectAgents();

      const project = await resolveTarget();
      if (!project) return;

      await launchAgent(chosen.id, { prompt: text, folder: project.dir });

      track("home_prompt_sent", { agent: chosen.id, target: target().kind });
      setPrompt("");
      setTarget({ kind: "new" });
      refetchProjects();
      navigate(projectRoute(projectKey(project)));
    } catch (e) {
      toast.error("Could not hand the prompt over", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  // Enter sends, shift+enter breaks the line — and the dashboard's global
  // shortcuts have no business reading what is typed here.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    void handleSubmit();
  };

  // Only the grid's own background clears the selection — a click that landed
  // on a card is that card's to handle.
  const clearSelection: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (
    event,
  ) => {
    if (event.target !== event.currentTarget) return;
    setSelectedProject(null);
  };

  const openProject = (project: ProjectInfo) => {
    track("project_opened");
    navigate(projectRoute(projectKey(project)));
  };

  const handleCreateProject = async () => {
    if (busy()) return;
    setBusy(true);

    try {
      if (!isDesktop()) {
        toast.error("Projects on disk are only available in the desktop app");
        return;
      }
      if (!(await ensureProjectsRoot())) return;

      const project = await createProject(generateProjectName());
      setSelectedProject(null);
      track("project_created");
      refetchProjects();
      openProject(project);
    } catch (e) {
      toast.error("Failed to create project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div class="flex flex-1 flex-col items-center justify-center gap-6.5 px-6 py-8 pt-[15%]">
          <h1 class="w-full text-center text-5xl leading-normal font-450 tracking-[0.0864px] text-muted-foreground">
            What should we edit?
          </h1>

          <div class="flex flex-col items-center">
            <div class="flex w-139 flex-col items-start rounded-t-xl border border-b-0 border-border bg-accent/50 px-1 pt-1 pb-0.5">
              <DropdownMenu placement="bottom-start">
                <DropdownMenuTrigger
                  as="button"
                  type="button"
                  aria-label="Choose the folder to work in"
                  class="flex h-7 shrink-0 items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-accent focus-ring"
                >
                  <span class="grid size-6 shrink-0 place-items-center overflow-clip">
                    <Icon name="navigation.folder" />
                  </span>
                  <span class="max-w-60 truncate">{targetLabel()}</span>
                  <span class="grid h-7 w-5 shrink-0 place-items-center overflow-clip">
                    <Icon name="chevron-down" />
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="w-60">
                    {/* One action, not a new/open pair: the picker takes any
                        folder, and a folder that is not a project yet becomes
                        one when the prompt is sent. */}
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={handlePickFolder}>
                        <Icon name="plus-add" />
                        <span class="min-w-0 flex-1 truncate">
                          Create project...
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <Show when={recentProjects().length > 0}>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuGroupLabel>
                          Recent projects
                        </DropdownMenuGroupLabel>
                        <For each={recentProjects().slice(0, MENU_PROJECTS)}>
                          {(project) => (
                            <DropdownMenuItem
                              onSelect={() =>
                                setTarget({ kind: "project", project })
                              }
                            >
                              <Icon name="navigation.folder" />
                              <span class="min-w-0 flex-1 truncate">
                                {project.displayName}
                              </span>
                            </DropdownMenuItem>
                          )}
                        </For>
                      </DropdownMenuGroup>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
            </div>

            <div class="z-10 flex w-149 flex-col gap-2 rounded-[20px] border border-border bg-accent p-2 focus-within:border-border-input">
              <textarea
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onKeyUp={(event) => event.stopPropagation()}
                placeholder={placeholder()}
                aria-label="Describe the edit you want"
                rows={2}
                class="max-h-60 min-h-12 w-full resize-none overflow-auto bg-transparent p-1 text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground selection:bg-selection selection:text-selection-foreground"
              />

              <div class="flex min-h-4 items-center justify-between">
                <AgentPicker
                  agents={agents()}
                  current={agent()}
                  onSelect={(id) => setPreferredAgent(id)}
                />

                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit()}
                  aria-label="Send to the coding agent"
                  class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40 focus-ring"
                >
                  <Show when={busy()} fallback={<Icon name="arrow-top" />}>
                    <Icon name="spinner-loader" class="animate-spin" />
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="flex shrink-0 flex-col">
          <div class="flex items-end gap-6 px-6 pt-4 pb-3">
            <h2 class="min-w-0 flex-1 text-2xl leading-6 font-450 text-foreground">
              Recent
            </h2>
          </div>
          <div
            data-slot="card-grid"
            onClick={clearSelection}
            class="grid grid-cols-5 items-start gap-x-0.5 gap-y-3 px-4 pb-4"
          >
            <DashboardCardButton onClick={handleCreateProject}>
              <DashboardCardPreview class="bg-overlay-soft group-hover:bg-overlay">
                <Icon
                  name="plus-add"
                  class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </DashboardCardPreview>
              <DashboardCardMeta title="New project" />
            </DashboardCardButton>
            <For each={recentProjects().slice(0, RECENT_COLUMNS - 1)}>
              {(project) => (
                <DashboardCardButton
                  active={selectedProject() === project.dir}
                  onClick={() => setSelectedProject(project.dir)}
                  onDoubleClick={() => openProject(project)}
                  onEscape={() => setSelectedProject(null)}
                >
                  <DashboardCardPreview>
                    <DashboardProjectThumbnail dir={project.dir} />
                  </DashboardCardPreview>
                  <DashboardCardMeta
                    title={project.displayName}
                    subtitle={formatEditedAt(project.modifiedAt)}
                  />
                </DashboardCardButton>
              )}
            </For>
          </div>
        </div>
      </div>
    </>
  );
}

type AgentPickerProps = {
  agents: readonly AgentInfo[];
  current: AgentInfo | null;
  onSelect: (id: string) => void;
};

/**
 * Which agent the prompt goes to. Every agent we support is listed, and the
 * ones with nothing on this machine to answer their link are shown disabled
 * rather than left out: a list that says what else this works with reads
 * better than one that silently varies from machine to machine, and a deep
 * link to an app that is not installed opens nothing at all.
 *
 * Off the desktop there is no list to show, only the reason there is none.
 */
function AgentPicker(props: AgentPickerProps) {
  return (
    <Show
      when={props.agents.length > 0}
      fallback={
        <p class="flex h-7 items-center px-2 text-xs text-muted-foreground">
          No coding agent found
        </p>
      }
    >
      <DropdownMenu placement="bottom-start">
        <DropdownMenuTrigger
          as="button"
          type="button"
          aria-label="Choose the coding agent"
          class="flex h-7 shrink-0 items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring"
        >
          <AgentLogo />
          <span class="max-w-40 truncate">
            {props.current?.label ?? "No agent installed"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="w-50">
            <DropdownMenuGroup>
              <For each={props.agents}>
                {(entry) => (
                  <DropdownMenuItem
                    disabled={!entry.available}
                    onSelect={() => props.onSelect(entry.id)}
                  >
                    <span class="min-w-0 flex-1 truncate">{entry.label}</span>
                    <Show
                      when={entry.available}
                      fallback={
                        <span class="shrink-0 text-[10px] text-muted-foreground">
                          Not installed
                        </span>
                      }
                    >
                      <Show when={entry.id === props.current?.id}>
                        <Icon name="confirm-check" class="size-6" />
                      </Show>
                    </Show>
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </Show>
  );
}

/** Placeholder for the per-agent logos, which the icon set does not have yet. */
function AgentLogo() {
  return (
    <span class="grid size-6 shrink-0 place-items-center overflow-clip">
      <Icon name="fx" />
    </span>
  );
}

/** An example with the trailing dots the typing works its way through too. */
function fullLine(index: number): string {
  return `${PROMPT_EXAMPLES[index]}...`;
}

/** `Ask Diffusion Studio to cut this`, however far the typing has got. */
function composePlaceholder(typed: string): string {
  return typed ? `${PROMPT_PREFIX} ${typed}` : PROMPT_PREFIX;
}

/**
 * The composer's placeholder: {@link PROMPT_PREFIX} stands still while the
 * rest types itself through {@link PROMPT_EXAMPLES} — a line arrives a
 * character at a time, trailing dots and all, holds long enough to be read,
 * erases, and the next one follows. It stops whenever `active` goes false, and for anyone who asked the
 * system for less motion it settles on the first line and stays there.
 */
function createTypedPlaceholder(active: () => boolean) {
  if (
    isServer ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return () => composePlaceholder(fullLine(0));
  }

  const [text, setText] = createSignal("");
  let line = 0;
  let erasing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = () => {
    const shown = text();
    const full = fullLine(line);

    if (!erasing && shown.length < full.length) {
      setText(full.slice(0, shown.length + 1));
      timer = setTimeout(step, TYPE_MS);
    } else if (!erasing) {
      erasing = true;
      timer = setTimeout(step, HOLD_MS);
    } else if (shown.length > 0) {
      setText(shown.slice(0, -1));
      timer = setTimeout(step, ERASE_MS);
    } else {
      erasing = false;
      line = (line + 1) % PROMPT_EXAMPLES.length;
      timer = setTimeout(step, TYPE_MS);
    }
  };

  createEffect(() => {
    clearTimeout(timer);
    if (active()) timer = setTimeout(step, TYPE_MS);
  });
  onCleanup(() => clearTimeout(timer));

  return () => composePlaceholder(text());
}

/** The last segment of a path, for naming a folder the user picked. */
function folderName(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || dir
  );
}
