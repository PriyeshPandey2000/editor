/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { createSignal } from 'solid-js';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import {
	findProjectRecords,
	forgetProject,
	lastUsedProjectRoot,
	listProjectRecords,
	moveProjectRecord,
	rememberProject,
	rememberProjectRoot,
} from '@/lib/db';

import type { CompileResult, ProjectInfo, SourceEdit, WriteResult } from '@desktop/main-channels';

export type { CompileResult, ProjectInfo, SourceEdit, WriteResult };

// The roots live in the app's IndexedDB (see @/lib/db) as a list keyed by
// path. The app works against one of them — the one used last — but the
// store is already the list several roots will need, so growing into them is
// UI rather than a migration.
//
// Reading a database is asynchronous, so the root starts null and arrives a
// tick later. Every call here waits for it, leaving only the UI to tell "no
// root yet" from "no root picked" — which is what `rootsReady` is for.

const [projectsRoot, setProjectsRoot] = createSignal<string | null>(null);
const [rootsReady, setRootsReady] = createSignal(false);

/** The folder new projects are created in: null until one is picked, and until `rootsReady`. */
export { projectsRoot };

/** Whether the roots have been read back from the database yet. */
export { rootsReady };

// Bumped whenever the list of known projects changes — one created, opened,
// renamed, copied, or deleted — so a view listing them can refetch on it.
const [projectsRevision, setProjectsRevision] = createSignal(1);

/** Changes whenever the list `listProjects` answers with would; a source for `createResource`. */
export { projectsRevision };

export const isDesktop = (): boolean => !!window.desktop;

const ready = new Promise<void>((resolve) => {
	lastUsedProjectRoot()
		.then((root) => setProjectsRoot(root?.path ?? null))
		.catch((error) => console.error('[projects] could not read the projects database', error))
		.finally(() => {
			setRootsReady(true);
			resolve();
		});
});

/** Puts `project` on the list (or marks it just opened) and tells the views. */
async function remember(project: ProjectInfo): Promise<void> {
	await rememberProject(project.dir, project.id);
	setProjectsRevision((revision) => revision + 1);
}

/** The projects root, waited for: null off the desktop and until one is picked. */
export async function getProjectsRoot(): Promise<string | null> {
	await ready;
	return projectsRoot();
}

/** Opens the native folder picker and remembers the chosen root. */
export async function pickProjectsRoot(): Promise<string | null> {
	const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_ROOT, undefined);
	if (!root) return null;

	await rememberProjectRoot(root);
	setProjectsRoot(root);
	return root;
}

/**
 * Opens the native folder picker for a folder to open as a single project.
 * Unlike `pickProjectsRoot` it changes nothing on its own — hand the path to
 * `openProjectFolder`, which is what makes the folder a project.
 */
export async function pickProjectFolder(): Promise<string | null> {
	if (!isDesktop()) return null;
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, undefined);
}

/**
 * The root to work against, waited for and — when there is none to wait for —
 * defaulted to. Null off the desktop, where there is no folder at all, and
 * when the user is asked where to put projects and declines to say.
 */
export async function ensureProjectsRoot(): Promise<string | null> {
	if (!isDesktop()) return null;
	await ready;

	const current = projectsRoot();
	if (current) return current;

	// Nothing picked yet: the default folder, so a first project costs a click
	// rather than a trip through the folder picker. The picker is still there
	// for anyone who wants to say — and for when the default will not do.
	const root = await mainBridge.call(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, undefined);
	if (!root) return pickProjectsRoot();

	await rememberProjectRoot(root);
	setProjectsRoot(root);
	return root;
}

/**
 * The projects the app knows that are still on disk, most recently opened
 * first. A record whose folder is gone (moved, trashed by hand, on a volume
 * that is not mounted) is skipped, not forgotten: it may well come back.
 */
export async function listProjects(): Promise<ProjectInfo[]> {
	await ready;
	if (!isDesktop()) return [];

	const records = await listProjectRecords();
	if (!records.length) return [];
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_LIST, { dirs: records.map((record) => record.dir) });
}

/** Creates a project folder under the root, named after `displayName`, and puts it on the list. */
export async function createProject(displayName: string): Promise<ProjectInfo> {
	await ready;
	const root = projectsRoot();
	if (!root) throw new Error('No projects folder selected.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_CREATE, { root, displayName });
	await remember(project);
	return project;
}

/**
 * The project `ref` names: its id, or — for links made before ids existed,
 * and folders opened by name — its folder name. Only projects on the list
 * can be found; the records say which folders to look in, and the folders
 * say what they are now (one may have been renamed or replaced behind our
 * back, or be a folder that predates ids — in which case main gives it one
 * here, so the app can put an id in the URL).
 */
export async function resolveProject(ref: string): Promise<ProjectInfo | null> {
	await ready;
	if (!ref || !isDesktop()) return null;

	for (const record of await findProjectRecords(ref)) {
		const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_RESOLVE, { dir: record.dir });
		if (!project || (project.id !== ref && project.name !== ref)) continue;
		// Just opened, and holding an id the record may not have had yet.
		await rememberProject(project.dir, project.id);
		return project;
	}
	return null;
}

/**
 * Opens the folder `dir` as a project, making it one first when it is not:
 * the folder is created if missing and, when nothing in it can be an entry,
 * given an `index.tsx` holding an empty stage — and nothing else. Put on the
 * list, so it stays reachable by name or id across relaunches. How
 * `dapi open <path>` lands anywhere on disk.
 */
export async function openProjectFolder(dir: string): Promise<ProjectInfo> {
	await ready;
	if (!isDesktop()) throw new Error('Opening a project folder requires the desktop app.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_INIT, { dir });
	await remember(project);
	return project;
}

/** The project in the folder `dir`, or null when there is none. */
export async function getProject(dir: string): Promise<ProjectInfo | null> {
	if (!dir || !isDesktop()) return null;
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_GET, { dir });
}

/**
 * Renames the project: `displayName` in the record, and the folder with it.
 * The folder moves, so the answer says where the project now lives — hold on
 * to it. Its id has not changed, and neither has its URL; the list follows
 * the folder.
 */
export async function renameProject(dir: string, displayName: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_RENAME, { dir, displayName });
	await moveProjectRecord(dir, project.dir);
	await remember(project);
	return project;
}

/** Copies the project in `dir` next to itself and returns the copy (a new id), on the list. */
export async function duplicateProject(dir: string): Promise<ProjectInfo> {
	if (!dir) throw new Error('No project folder.');

	const project = await mainBridge.call(MAIN_CHANNELS.PROJECTS_DUPLICATE, { dir });
	await remember(project);
	return project;
}

/** Moves the project in `dir` to the trash and takes it off the list. */
export async function deleteProject(dir: string): Promise<void> {
	if (!dir) throw new Error('No project folder.');

	await mainBridge.call(MAIN_CHANNELS.PROJECTS_DELETE, { dir });
	await forgetProject(dir);
	setProjectsRevision((revision) => revision + 1);
}

/**
 * What to put in a project's URL: its id, or its folder name while it has
 * none (a folder that predates ids gets one the next time it is opened).
 */
export const projectKey = (project: ProjectInfo): string => project.id || project.name;

export function compileProject(dir: string): Promise<CompileResult> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_COMPILE, { dir });
}

/**
 * Writes changed props back into the project's JSX. No compile follows: the
 * canvas is already showing these values, and main keeps the write from
 * reaching the watcher (see `noteContent` in the desktop's projects.ts).
 */
export function writeProject(dir: string, edits: SourceEdit[]): Promise<WriteResult> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_WRITE, { dir, edits });
}

/** The project's config (the `diffusion` field of its package.json), unparsed; null when absent. */
export function readProjectConfig(dir: string): Promise<unknown> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_CONFIG_READ, { dir });
}

/** Replaces the project's config (null removes the field). Kept from the watcher like `writeProject`. */
export function writeProjectConfig(dir: string, config: unknown): Promise<void> {
	return mainBridge.call(MAIN_CHANNELS.PROJECTS_CONFIG_WRITE, { dir, config });
}

/**
 * Watches a project folder and calls `onChange` with every file that changed
 * since the last call, coalescing a burst of them — an install, a checkout, a
 * folder dropped into the library — into one answer.
 *
 * The delay buys throughput and nothing else: main keeps the app's own writes
 * out of this stream by their content rather than by their timing (see
 * `noteContent` in the desktop's projects.ts) and writes whole files, so no
 * amount of waiting here is load-bearing.
 */
export function watchProject(dir: string, onChange: (paths: string[]) => void, debounceMs = 80): () => void {
	if (!isDesktop()) return () => { };

	let pending: ReturnType<typeof setTimeout> | undefined;
	let changed = new Set<string>();
	const stop = mainBridge.handle(MAIN_CHANNELS.PROJECTS_CHANGED, (event) => {
		if (event.dir !== dir) return;
		changed.add(event.path);
		clearTimeout(pending);
		pending = setTimeout(() => {
			const paths = [...changed];
			changed = new Set();
			onChange(paths);
		}, debounceMs);
	});

	mainBridge.call(MAIN_CHANNELS.PROJECTS_WATCH, { dir });

	return () => {
		clearTimeout(pending);
		stop();
		mainBridge.call(MAIN_CHANNELS.PROJECTS_UNWATCH, { dir }).catch(() => { });
	};
}
