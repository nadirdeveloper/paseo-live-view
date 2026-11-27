import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createSnapshots } from "./snapshot";

let root: string;
let clock = Date.now() / 1000;

/** Write a file with a clearly newer mtime, so tests don't depend on timestamp resolution. */
async function put(name: string, text: string | Buffer): Promise<string> {
  const path = join(root, name);
  await writeFile(path, text);
  clock += 10;
  await utimes(path, clock, clock);
  return path;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "live-view-snap-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
});

describe("createSnapshots", () => {
  test("changes() on an unprimed root primes and returns []", async () => {
    await put("a.txt", "one\n");
    const snaps = createSnapshots();
    expect(await snaps.changes(root)).toEqual([]);
  });

  test("reports before and after for a modified file", async () => {
    const path = await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    await put("a.txt", "two\n");
    expect(await snaps.changes(root)).toEqual([{ path, before: "one\n", after: "two\n" }]);
  });

  test("reports each change once", async () => {
    await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    await put("a.txt", "two\n");
    await snaps.changes(root);
    expect(await snaps.changes(root)).toEqual([]);
  });

  test("a new file has no before text; a deleted file has no after text", async () => {
    const gone = await put("gone.txt", "bye\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    const added = await put("new.txt", "hi\n");
    await rm(gone);
    const changes = await snaps.changes(root);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ path: added, before: null, after: "hi\n" });
    expect(changes).toContainEqual({ path: gone, before: "bye\n", after: null });
  });

  test("remember() suppresses a change that was already shown", async () => {
    const path = await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    await put("a.txt", "two\n");
    snaps.remember(root, path, "two\n");
    expect(await snaps.changes(root)).toEqual([]);
  });

  test("skips binary files and files over the size limit", async () => {
    await put("bin.dat", Buffer.from([1, 0, 2]));
    await put("big.txt", "0123456789abcdef");
    const snaps = createSnapshots({ maxFileBytes: 10 });
    await snaps.prime(root);
    await put("bin.dat", Buffer.from([3, 0, 4]));
    await put("big.txt", "fedcba9876543210");
    expect(await snaps.changes(root)).toEqual([]);
  });

  test("a newer mtime with the same content reports nothing", async () => {
    await put("a.txt", "same\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    await put("a.txt", "same\n");
    expect(await snaps.changes(root)).toEqual([]);
  });

  test("stops caching once the total size limit is reached", async () => {
    await put("a.txt", "aaaaaa");
    await put("b.txt", "bbbbbb");
    const snaps = createSnapshots({ maxTotalBytes: 8 });
    await snaps.prime(root);
    await put("a.txt", "AAAAAA");
    await put("b.txt", "BBBBBB");
    // Only one of the two fit in the snapshot, so only one change can be reported.
    expect(await snaps.changes(root)).toHaveLength(1);
  });

  test("rebaseline() forgets changes made while nobody was watching", async () => {
    await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(root);
    await put("a.txt", "two\n");
    await snaps.rebaseline(root);
    expect(await snaps.changes(root)).toEqual([]);
    const path = await put("a.txt", "three\n");
    expect(await snaps.changes(root)).toEqual([{ path, before: "two\n", after: "three\n" }]);
  });

  test("reports paths under the root as it was given, even through a symlink", async () => {
    const link = join(await realpath(await mkdtemp(join(tmpdir(), "live-view-link-"))), "ws");
    await symlink(root, link);
    await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(link);
    await put("a.txt", "two\n");
    expect(await snaps.changes(link)).toEqual([{ path: join(link, "a.txt"), before: "one\n", after: "two\n" }]);
  });

  test("remember() accepts the real path of a file under a symlinked root", async () => {
    const link = join(await realpath(await mkdtemp(join(tmpdir(), "live-view-link-"))), "ws");
    await symlink(root, link);
    const real = await put("a.txt", "one\n");
    const snaps = createSnapshots();
    await snaps.prime(link);
    await put("a.txt", "two\n");
    snaps.remember(link, real, "two\n");
    expect(await snaps.changes(link)).toEqual([]);
  });

  test("reports at most maxChanges files per check and quietly takes in the rest", async () => {
    for (const name of ["a", "b", "c"]) await put(`${name}.txt`, "1\n");
    const snaps = createSnapshots({ maxChanges: 2 });
    await snaps.prime(root);
    for (const name of ["a", "b", "c"]) await put(`${name}.txt`, "2\n");
    expect(await snaps.changes(root)).toHaveLength(2);
    expect(await snaps.changes(root)).toEqual([]);
  });
});
