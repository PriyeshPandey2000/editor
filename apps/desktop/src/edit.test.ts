/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The canvas shows an edit before the file has it, and an export and the next
// open render the file: an edit the write left out would move back. So the
// user wins — a prop is written over whatever the source held for it.

import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdits } from "./edit";

const FILE = "main.tsx";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edit-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyEdits", () => {
  it("writes a prop over a literal and over an expression alike", async () => {
    await writeFile(
      join(dir, FILE),
      `const X = 100;\nexport default () => <video id="clip" x={X} y={20} rotation={ticker() * 2} />;\n`,
    );

    const result = await applyEdits({ dir }, [
      { kind: "set", source: `${FILE}:clip`, props: { x: 555, y: 42, rotation: 90 } },
    ]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toContain(`<video id="clip" x={555} y={42} rotation={90} />`);
    // The constant is someone else's too, and stays.
    expect(text).toContain(`const X = 100;`);
  });
});
