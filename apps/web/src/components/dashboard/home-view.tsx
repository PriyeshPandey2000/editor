/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
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
import { RemoveButton } from "@/components/ui/remove-button";
import { projectRoute } from "@/hooks/use-project-route";
import { store } from "@/init";
import { AGENTS, agentIcon, type AgentInfo } from "@/lib/agents";
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

import { DeleteProjectDialog } from "./delete-project-dialog";
import { DashboardProjectCard } from "./project-card";
import {
  DashboardCardButton,
  DashboardCardMeta,
  DashboardCardPreview,
  createBackgroundClickHandler,
} from "./shared";
import { parseTimestamp } from "./utils";

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

/**
 * A file or folder dropped onto the composer. Only what the tile and the
 * handoff need: the name to label it, the kind and extension to draw it, and
 * the path to send — null off the desktop, where the browser will not say
 * where a dropped file lives.
 */
type PromptAttachment = {
  key: string;
  name: string;
  kind: "file" | "folder";
  path: string | null;
};

/** Cards that fit the one row the design gives recents, the new one included. */
const RECENT_COLUMNS = 5;

/** Recent projects the target menu offers before it gets unwieldy. */
const MENU_PROJECTS = 8;


/** The edits the placeholder cycles through, one whole line at a time. */
const PROMPT_EXAMPLES = [
  "Turn this footage into a polished YouTube video. Add readable captions and an attention-grabbing graphic in the opening to give viewers a strong visual hook.",
  "Can you pull the best 30-second moment from https://youtu.be/MtQ0qxyf-Ds and make a vertical version for social?",
  "In three bullets, explain what starts the conflict. Include timestamps. https://youtu.be/aqz-KE-bpKQ",
  "Name three recurring locations and give one visual cue that distinguishes each. https://youtu.be/dQw4w9WgXcQ",
];

/** Milliseconds a line takes to fade in or out, and how long it stays readable. */
const FADE_MS = 500;
const HOLD_MS = 2400;

export function DashboardHomeView() {
  const navigate = useNavigate();

  const [prompt, setPrompt] = createSignal("");
  const [target, setTarget] = createSignal<PromptTarget>({ kind: "new" });
  const [selectedProject, setSelectedProject] = createSignal<string | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);
  const [attachments, setAttachments] = createSignal<PromptAttachment[]>([]);

  // Drag events fire on every child the pointer crosses, so the overlay is
  // held up by a count of nested enters rather than the last event seen.
  let dragCounter = 0;
  const [isDragging, setIsDragging] = createSignal(false);

  // Only worth animating while the field is empty — the placeholder is not on
  // screen behind text the user has typed.
  const placeholder = createFadingPlaceholder(() => prompt().length === 0);

  const [projects, { refetch: refetchProjects }] = createResource(
    projectsRoot,
    () => listProjects(),
  );
  // The agent outlives the session, so the next prompt goes where the last one
  // did — unless that one is not installed, in which case the first that is
  // becomes what the button shows and what submitting uses.
  const [preferredAgent, setPreferredAgent] = createStoredSignal(
    store.define<string | null>("home.agent", null),
  );

  const agent = createMemo(() => {
    const usable = AGENTS.filter((entry) => entry.installed);
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

  const canSubmit = () => prompt().trim().length > 0 && !busy();

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
      toast.error("Projects on disk are only available in the desktop app");
      return;
    }

    const paths = attachments().flatMap((entry) => (entry.path ? [entry.path] : []));
    setBusy(true);

    try {
      // For now the prompt only picks the project: nothing is handed to the
      // agent and no CLI or MCP setup runs. The project is opened as is.
      const project = await resolveTarget();
      if (!project) return;

      track("home_prompt_sent", {
        agent: agent()?.id ?? null,
        target: target().kind,
        attachments: paths.length,
      });
      setPrompt("");
      setAttachments([]);
      setTarget({ kind: "new" });
      refetchProjects();
      navigate(projectRoute(projectKey(project)));
    } catch (e) {
      toast.error("Could not open the project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDragEnter = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter++;
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setIsDragging(false);
    }
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter = 0;
    setIsDragging(false);

    const dropped = droppedAttachments(event);
    if (dropped.length === 0) return;

    // The same file dropped twice is one attachment, not two tiles.
    setAttachments((current) => {
      const known = new Set(current.map((entry) => entry.key));
      return [...current, ...dropped.filter((entry) => !known.has(entry.key))];
    });
  };

  const removeAttachment = (key: string) => {
    setAttachments((current) => current.filter((entry) => entry.key !== key));
  };

  // Enter sends, shift+enter breaks the line — and the dashboard's global
  // shortcuts have no business reading what is typed here.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    void handleSubmit();
  };

  // Anything outside a card clears the selection — the grid's gaps, the space
  // around it, and the composer above it. A click on a card is that card's.
  const clearSelection = createBackgroundClickHandler(() =>
    setSelectedProject(null),
  );

  const [pendingDelete, setPendingDelete] = createSignal<ProjectInfo | null>(null);

  const handleDeleted = (project: ProjectInfo) => {
    setSelectedProject((current) => (current === project.dir ? null : current));
    refetchProjects();
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
      <div
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onClick={clearSelection}
      >
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

            <div
              class="relative z-10 flex w-149 flex-col gap-2 rounded-[20px] border border-border bg-accent p-2 focus-within:border-border-input"
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <Show when={attachments().length > 0}>
                {/* The remove buttons overhang the tiles' corners, and a
                    scrolling row clips at its edge — so the row pads for them
                    and pulls itself back up by the same amount. */}
                <div class="-mt-2.5 flex w-full items-start gap-2 overflow-x-auto pt-2.5 pr-2.5">
                  <For each={attachments()}>
                    {(entry) => (
                      <AttachmentTile
                        attachment={entry}
                        onRemove={() => removeAttachment(entry.key)}
                      />
                    )}
                  </For>
                </div>
              </Show>

              <div class="grid">
                <Show when={prompt().length === 0}>
                  <span
                    aria-hidden="true"
                    class="pointer-events-none [grid-area:1/1] whitespace-pre-wrap break-words p-1 text-[12px] leading-5 text-muted-foreground transition-opacity ease-in-out"
                    style={{ "transition-duration": `${FADE_MS}ms` }}
                    classList={{ "opacity-0": !placeholder.visible() }}
                  >
                    {placeholder.line()}
                  </span>
                </Show>

                <textarea
                  value={prompt()}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                  onKeyUp={(event) => event.stopPropagation()}
                  aria-label="Describe the edit you want"
                  aria-placeholder={placeholder.line()}
                  rows={2}
                  class="[grid-area:1/1] max-h-60 min-h-12 w-full resize-none overflow-auto bg-transparent p-1 text-[12px] leading-5 text-foreground outline-none selection:bg-selection selection:text-selection-foreground"
                />
              </div>

              <div class="flex min-h-4 items-center justify-between">
                <AgentPicker
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

              <Show when={isDragging()}>
                <div class="absolute inset-0 z-20 overflow-hidden rounded-[20px] border border-primary bg-background p-2">
                  <div class="absolute inset-0 rounded-[20px] bg-muted" />
                  <div class="relative flex size-full items-center justify-center gap-1 rounded-xl">
                    <svg
                      aria-hidden="true"
                      class="pointer-events-none absolute inset-[0.5px] size-[calc(100%-1px)] overflow-visible text-border-input opacity-15"
                    >
                      <rect
                        width="100%"
                        height="100%"
                        rx="12"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1"
                        stroke-dasharray="8 4"
                        shape-rendering="crispEdges"
                      />
                    </svg>
                    <Icon name="attachment" class="size-6 text-muted-foreground" />
                    <span class="text-xs font-450 text-muted-foreground">
                      Drop files or folders here
                    </span>
                  </div>
                </div>
              </Show>
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
                <DashboardProjectCard
                  project={project}
                  active={selectedProject() === project.dir}
                  onSelect={() => setSelectedProject(project.dir)}
                  onDeselect={() => setSelectedProject(null)}
                  onOpen={() => openProject(project)}
                  onDelete={() => setPendingDelete(project)}
                  onChanged={refetchProjects}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      <DeleteProjectDialog
        project={pendingDelete()}
        onClose={() => setPendingDelete(null)}
        onDeleted={handleDeleted}
      />
    </>
  );
}

type AgentPickerProps = {
  current: AgentInfo | null;
  onSelect: (id: string) => void;
};

/**
 * Which agent the prompt goes to. Every agent in {@link AGENTS} is listed,
 * and the ones not marked installed are shown disabled rather than left out,
 * so the list says what else this works with.
 */
function AgentPicker(props: AgentPickerProps) {
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenuTrigger
        as="button"
        type="button"
        aria-label="Choose the coding agent"
        class="flex h-7 shrink-0 items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring"
      >
        <AgentLogo agent={props.current} />
        <span class="max-w-40 truncate">
          {props.current?.label ?? "No agent installed"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-50">
          <DropdownMenuGroup>
            <For each={AGENTS}>
              {(entry) => (
                <DropdownMenuItem
                  disabled={!entry.installed}
                  onSelect={() => props.onSelect(entry.id)}
                >
                  <Icon name={agentIcon(entry)} />
                  <span class="min-w-0 flex-1 truncate">{entry.label}</span>
                  <Show
                    when={entry.installed}
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
  );
}

/** The agent's mark in the composer, in the same box the folder icon sits in. */
function AgentLogo(props: { agent: AgentInfo | null }) {
  return (
    <span class="grid size-6 shrink-0 place-items-center overflow-clip">
      <Icon name={agentIcon(props.agent)} />
    </span>
  );
}

/**
 * The composer's placeholder, cycling through {@link PROMPT_EXAMPLES}: each
 * prompt fades in whole, however many lines it wraps to, holds long enough
 * to be read, fades out, and the next one follows. It pauses whenever `active` goes false, and for anyone who asked
 * the system for less motion it settles on the first line and stays there.
 */
function createFadingPlaceholder(active: () => boolean) {
  const [index, setIndex] = createSignal(0);
  const line = () => PROMPT_EXAMPLES[index()];

  if (
    isServer ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return { line, visible: () => true };
  }

  const [visible, setVisible] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = () => {
    if (visible()) {
      setVisible(false);
      timer = setTimeout(step, FADE_MS);
    } else {
      setIndex((current) => (current + 1) % PROMPT_EXAMPLES.length);
      setVisible(true);
      timer = setTimeout(step, FADE_MS + HOLD_MS);
    }
  };

  createEffect(() => {
    clearTimeout(timer);
    setVisible(false);
    if (!active()) return;

    // The span mounts at opacity 0 first, so its first line fades in like
    // the rest instead of appearing in one go.
    timer = setTimeout(() => {
      setVisible(true);
      timer = setTimeout(step, FADE_MS + HOLD_MS);
    }, 50);
  });
  onCleanup(() => clearTimeout(timer));

  return { line, visible };
}

type AttachmentTileProps = {
  attachment: PromptAttachment;
  onRemove(): void;
};

/**
 * One dropped file or folder: a grey square with a folder mark, or the file's
 * type in the middle. There is no thumbnail to show — nothing is loaded — so
 * the name is in the tooltip and the remove button appears on hover, as it
 * does on the generation composer's reference images.
 */
function AttachmentTile(props: AttachmentTileProps) {
  return (
    <div class="group relative size-10 shrink-0" title={props.attachment.name}>
      <div class="grid size-full place-items-center overflow-hidden rounded-lg bg-input text-muted-foreground">
        <Show
          when={props.attachment.kind === "folder"}
          fallback={
            <span class="max-w-9 truncate px-0.5 text-[9px] font-500 uppercase tracking-wide">
              {fileType(props.attachment.name)}
            </span>
          }
        >
          <Icon name="navigation.folder" class="size-6" />
        </Show>
      </div>
      <RemoveButton
        label={`Remove ${props.attachment.name}`}
        class="absolute -right-2.5 -top-2.5 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={props.onRemove}
      />
    </div>
  );
}

/** `MP4` for `clip.mp4`, `FILE` for a name with no extension to speak of. */
function fileType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext && ext.length <= 8 ? ext : "FILE";
}

/**
 * The files and folders in a drop, in the order they were dragged. Folders
 * are told apart through the entry API, the only thing a drop says about a
 * directory; the path comes from the desktop shell, which is the only one
 * that knows it. Nothing is opened or read.
 */
function droppedAttachments(event: DragEvent): PromptAttachment[] {
  const items = Array.from(event.dataTransfer?.items ?? []);
  const result: PromptAttachment[] = [];

  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    const file = item.getAsFile();
    if (!file) continue;

    const path = window.desktop?.getPathForFile(file) || null;
    const name = entry?.name || file.name;
    result.push({
      key: path ?? `${name}:${file.size}:${file.lastModified}`,
      name,
      kind: entry?.isDirectory ? "folder" : "file",
      path,
    });
  }

  return result;
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
