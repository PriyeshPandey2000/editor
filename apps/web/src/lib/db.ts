/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openDB } from 'idb';
import type * as idb from 'idb';

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
 * A project the app knows: one it created, one it was asked to open — from
 * the folder picker, or `dapi open <path>` — or one found in the projects
 * root when that was chosen. The dashboard lists these and nothing else.
 * Keyed by folder, which is how main addresses a project. The id is a copy of
 * what the folder's package.json said last time — enough to find the folder
 * a URL names without reading every record's package.json — and the folder
 * has the final say (see `resolveProject` in @/projects).
 *
 * The projects root itself is not in here: there is one, so it lives in
 * localStorage (see @/projects).
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

type UpgradeTransaction = Parameters<NonNullable<idb.OpenDBCallbacks<GlobalDBSchema>['upgrade']>>[3];

const DB_NAME = 'diffusion-studio-idb';
const DB_VERSION = 3;

const dbPromise = openDB<GlobalDBSchema>(DB_NAME, DB_VERSION, {
  async upgrade(db, _oldVersion, _newVersion, tx) {
    if (!db.objectStoreNames.contains('bundles')) {
      db.createObjectStore('bundles', { keyPath: 'projectId' });
    }
    if (!db.objectStoreNames.contains('projects')) {
      const store = db.createObjectStore('projects', { keyPath: 'dir' });
      store.createIndex('by-id', 'id');
      store.createIndex('by-last-opened', 'lastOpenedAt');
    }
    if (db.objectStoreNames.contains('roots' as never)) await retireRoots(db, tx);
  },
});

/**
 * Versions 1 and 2 kept a `roots` store: folders the dashboard scanned for
 * projects (`kind: 'multi'`), and single project folders registered on their
 * own (`kind: 'single'`). Version 3 does away with it. The single ones become
 * project records; the multi ones are dropped — the projects root lives in
 * localStorage now, and the projects the old one held come back on record
 * when the user picks a root again (see `adoptProjectsRoot` in @/projects).
 */
async function retireRoots(db: idb.IDBPDatabase<GlobalDBSchema>, tx: UpgradeTransaction): Promise<void> {
  type LegacyRoot = { path: string; kind?: 'multi' | 'single'; createdAt: string; lastUsedAt: string };
  const projects = tx.objectStore('projects');

  // The store is not in the schema any more, so it is addressed by name.
  const roots = (tx as unknown as idb.IDBPTransaction<unknown, string[], 'versionchange'>).objectStore('roots');
  for (const root of (await roots.getAll()) as LegacyRoot[]) {
    if (root.kind !== 'single') continue;
    await projects.put({ dir: root.path, id: '', createdAt: root.createdAt, lastOpenedAt: root.lastUsedAt });
  }

  db.deleteObjectStore('roots' as never);
}

/** Last segment of a path, whichever separator it uses. */
const folderLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// ---------------------------------------------------------------------------
// Project records

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

/**
 * Puts every project in `found` that is not on record yet on it, leaving the
 * ones that are alone — they were opened when they were opened. Answers with
 * how many were new. For the projects a freshly chosen root turns out to hold.
 */
export async function addProjectRecords(found: Array<{ dir: string; id: string }>): Promise<number> {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const tx = db.transaction('projects', 'readwrite');
  let added = 0;

  for (const { dir, id } of found) {
    if (await tx.store.getKey(dir)) continue;
    await tx.store.put({ dir, id, createdAt: now, lastOpenedAt: now });
    added++;
  }

  await tx.done;
  return added;
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

// ---------------------------------------------------------------------------
// Project bundles

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
