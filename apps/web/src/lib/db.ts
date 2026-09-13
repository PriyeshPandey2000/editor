/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openDB } from 'idb';
import type * as idb from 'idb';
import { nanoid } from 'nanoid';

const adjectives = ["Golden", "Silent", "Fast", "Bright", "Dark", "Wild", "Calm"];
const nouns = ["River", "Mountain", "Dream", "Storm", "Sunset", "Forest", "Ocean"];

function getRandomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function generateProjectName(): string {
  const adj = getRandomElement(adjectives);
  const noun = getRandomElement(nouns);
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString("en-US", { month: "short" });
  return `${adj} ${noun} ${day} ${month}`;
}

/**
 * A folder new projects are created in (desktop; see @/projects). A path
 * rather than a handle: on desktop the main process does the creating, and
 * it takes paths. Creating is the folder's one job — nothing looks inside it.
 * The projects the app shows are the ones it has on record (`ProjectRecord`),
 * wherever they live.
 *
 * Stored as a list because there will be several. The app works against one
 * at a time for now — the most recently used, so no separate "active" flag
 * can end up pointing at a root that was removed.
 */
export interface ProjectRoot {
  id: string;
  path: string; // Absolute path of the folder.
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * A project the app knows: one it created, or one it was asked to open — from
 * the folder picker, or `dapi open <path>`. The dashboard lists these and
 * nothing else; the disk is never searched for projects. Keyed by folder,
 * which is how main addresses a project. The id is a copy of what the
 * folder's package.json said last time — enough to find the folder a URL
 * names without reading every record's package.json — and the folder has the
 * final say (see `resolveProject` in @/projects).
 */
export interface ProjectRecord {
  dir: string; // Absolute path of the project folder.
  id: string; // package.json `projectId`; "" while the folder has none.
  createdAt: string; // When the app first put it on record.
  lastOpenedAt: string;
}

/**
 * The bundle a project last mounted successfully, keyed by its id. Two jobs:
 * the copy an export re-renders (see `@/engine/capture`), and the head start
 * the next open of the project mounts while its first compile still runs.
 * Written only after a mount lands, so what is here is always something the
 * canvas has shown.
 */
export interface ProjectBundle {
  projectId: string;
  code: string;
  updatedAt: string;
}

export interface GlobalDBSchema extends idb.DBSchema {
  roots: {
    value: ProjectRoot;
    key: string;
    indexes: {
      'by-path': string;
      'by-last-used': string;
    };
  };
  projects: {
    value: ProjectRecord;
    key: string;
    indexes: {
      'by-id': string;
      'by-last-opened': string;
    };
  };
  bundles: {
    value: ProjectBundle;
    key: string;
  };
}

const DB_NAME = 'diffusion-studio-idb';
const DB_VERSION = 3;

const dbPromise = openDB<GlobalDBSchema>(DB_NAME, DB_VERSION, {
  async upgrade(db, oldVersion, _newVersion, tx) {
    if (!db.objectStoreNames.contains('roots')) {
      const store = db.createObjectStore('roots', { keyPath: 'id' });
      store.createIndex('by-path', 'path', { unique: true });
      store.createIndex('by-last-used', 'lastUsedAt');
    }
    if (!db.objectStoreNames.contains('bundles')) {
      db.createObjectStore('bundles', { keyPath: 'projectId' });
    }
    if (!db.objectStoreNames.contains('projects')) {
      const store = db.createObjectStore('projects', { keyPath: 'dir' });
      store.createIndex('by-id', 'id');
      store.createIndex('by-last-opened', 'lastOpenedAt');
    }
    if (oldVersion > 0 && oldVersion < 3) {
      const roots = tx.objectStore('roots');
      const projects = tx.objectStore('projects');

      let cursor = await roots.openCursor();
      while (cursor) {
        const { kind, ...root } = cursor.value as ProjectRoot & { kind?: 'multi' | 'single' };
        if (kind === 'single') {
          await projects.put({ dir: root.path, id: '', createdAt: root.createdAt, lastOpenedAt: root.lastUsedAt });
          await cursor.delete();
        } else if (kind) {
          await cursor.update(root);
        }
        cursor = await cursor.continue();
      }
    }
  },
});


/** Last segment of a path, whichever separator it uses. */
const folderLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Records `path` as a projects root, or marks the one already recorded for
 * it as just used — which is what makes it the active one.
 */
export async function rememberProjectRoot(path: string): Promise<ProjectRoot> {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const existing = await db.getFromIndex('roots', 'by-path', path);

  const root: ProjectRoot = existing
    ? { ...existing, name: folderLabel(path), lastUsedAt: now }
    : { id: nanoid(), path, name: folderLabel(path), createdAt: now, lastUsedAt: now };

  await db.put('roots', root);
  return root;
}

/** Every projects root, most recently used first. */
export async function listProjectRoots(): Promise<ProjectRoot[]> {
  const db = await dbPromise;
  return (await db.getAllFromIndex('roots', 'by-last-used')).reverse();
}

/** The root the app is working against: the one used last, or null when there is none. */
export async function lastUsedProjectRoot(): Promise<ProjectRoot | null> {
  const db = await dbPromise;
  const cursor = await db
    .transaction('roots', 'readonly')
    .store.index('by-last-used')
    .openCursor(null, 'prev');
  return cursor?.value ?? null;
}

/** Forgets a projects root. The folder itself is left alone. */
export async function forgetProjectRoot(id: string): Promise<void> {
  const db = await dbPromise;
  await db.delete('roots', id);
}

/**
 * Puts the project in `dir` on record, or marks the one already recorded
 * there as just opened. `id` is what its package.json says now — the record
 * keeps a copy, so a folder that has since been given an id gets it here.
 */
export async function rememberProject(dir: string, id: string): Promise<ProjectRecord> {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const existing = await db.get('projects', dir);

  const record: ProjectRecord = existing
    ? { ...existing, id, lastOpenedAt: now }
    : { dir, id, createdAt: now, lastOpenedAt: now };

  await db.put('projects', record);
  return record;
}

/** Every project on record, most recently opened first. */
export async function listProjectRecords(): Promise<ProjectRecord[]> {
  const db = await dbPromise;
  return (await db.getAllFromIndex('projects', 'by-last-opened')).reverse();
}

/**
 * The records `ref` could name: those whose id it is, then — for links made
 * before ids existed, and folders opened by name — those whose folder it
 * names. Most recently opened first within each, so a project that was just
 * open wins over a copy of it.
 */
export async function findProjectRecords(ref: string): Promise<ProjectRecord[]> {
  const records = await listProjectRecords();
  return [
    ...records.filter((record) => record.id === ref),
    ...records.filter((record) => record.id !== ref && folderLabel(record.dir) === ref),
  ];
}

/**
 * Re-keys the record for `from` to `to`, for a project whose folder moved
 * (renaming one moves its folder). Nothing to do when `from` is not on record.
 */
export async function moveProjectRecord(from: string, to: string): Promise<void> {
  if (from === to) return;
  const db = await dbPromise;
  const tx = db.transaction('projects', 'readwrite');
  const existing = await tx.store.get(from);
  if (existing) {
    await tx.store.delete(from);
    await tx.store.put({ ...existing, dir: to });
  }
  await tx.done;
}

/** Takes the project in `dir` off the record. The folder itself is left alone. */
export async function forgetProject(dir: string): Promise<void> {
  const db = await dbPromise;
  await db.delete('projects', dir);
}

/** Records the bundle `projectId` just mounted, replacing the one before it. */
export async function rememberProjectBundle(projectId: string, code: string): Promise<void> {
  try {
    const db = await dbPromise;
    await db.put('bundles', { projectId, code, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Failed to remember project bundle', e);
  }
}

/** The bundle `projectId` last mounted, or null when it has none on record. */
export async function loadProjectBundle(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  try {
    const db = await dbPromise;
    return (await db.get('bundles', projectId))?.code ?? null;
  } catch (e) {
    console.error('Failed to load project bundle', e);
    return null;
  }
}

/** Forgets a project's bundle, for when the project itself is deleted. */
export async function forgetProjectBundle(projectId: string): Promise<void> {
  if (!projectId) return;
  try {
    const db = await dbPromise;
    await db.delete('bundles', projectId);
  } catch (e) {
    console.error('Failed to forget project bundle', e);
  }
}
