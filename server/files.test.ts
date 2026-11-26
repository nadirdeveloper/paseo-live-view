import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { listFiles, readText, resolveInside } from "./files";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "live-view-root-")));
});

describe("resolveInside", () => {
  test("accepts relative and absolute paths inside the root", async () => {
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "b.txt"), "x");
    expect(await resolveInside(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
    expect(await resolveInside(root, join(root, "a", "b.txt"))).toBe(join(root, "a", "b.txt"));
  });

  test("accepts a path that does not exist yet inside the root", async () => {
    expect(await resolveInside(root, "new/file.txt")).toBe(join(root, "new", "file.txt"));
  });

  test("rejects parent escapes and absolute paths outside", async () => {
    expect(await resolveInside(root, "../x")).toBeNull();
    expect(await resolveInside(root, "/etc/passwd")).toBeNull();
  });

  test("rejects a symlink inside the root that points outside", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "live-view-outside-")));
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(outside, join(root, "link"));
    expect(await resolveInside(root, "link/secret.txt")).toBeNull();
  });
});

describe("listFiles", () => {
  test("in a git repo lists tracked and untracked files but not ignored ones", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "kept.txt"), "k");
    await writeFile(join(root, "ignored.txt"), "i");
    execFileSync("git", ["add", "kept.txt", ".gitignore"], { cwd: root });
    await writeFile(join(root, "new.txt"), "n");
    const { paths, capped } = await listFiles(root);
    expect(paths).toEqual([".gitignore", "kept.txt", "new.txt"]);
    expect(capped).toBe(false);
  });

  test("outside git skips node_modules and .git", async () => {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "x.js"), "x");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "c");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const { paths } = await listFiles(root);
    expect(paths).toEqual(["b.txt", "src/a.ts"]);
  });

  test("caps the number of entries", async () => {
    for (const name of ["1.txt", "2.txt", "3.txt"]) await writeFile(join(root, name), name);
    const { paths, capped } = await listFiles(root, 2);
    expect(paths).toHaveLength(2);
    expect(capped).toBe(true);
  });
});

describe("readText", () => {
  test("reads a text file", async () => {
    await writeFile(join(root, "a.txt"), "hello");
    expect(await readText(root, "a.txt")).toEqual({ status: "ok", text: "hello" });
  });

  test("refuses paths outside the root", async () => {
    expect(await readText(root, "../x")).toEqual({ status: "outside" });
  });

  test("reports a missing file", async () => {
    expect(await readText(root, "nope.txt")).toEqual({ status: "missing" });
  });

  test("reports a file over the size cap", async () => {
    await writeFile(join(root, "big.txt"), "0123456789");
    expect(await readText(root, "big.txt", 4)).toEqual({ status: "too-large" });
  });

  test("reports a binary file", async () => {
    await writeFile(join(root, "bin.dat"), Buffer.from([65, 0, 66]));
    expect(await readText(root, "bin.dat")).toEqual({ status: "binary" });
  });
});
