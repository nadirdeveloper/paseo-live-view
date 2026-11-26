import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FilesReadOutput } from "../shared/files";

const run = promisify(execFile);

export const MAX_READ_BYTES = 1048576;
export const MAX_LIST_ENTRIES = 5000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** Real absolute path of `path` if it stays inside `root` after resolving symlinks, else null. */
export async function resolveInside(root: string, path: string): Promise<string | null> {
  const realRoot = await realpath(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(realRoot, path);
  // Resolve symlinks on the nearest ancestor that exists; the rest of the path doesn't exist yet.
  let existing = target;
  let rest = "";
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = rest ? join(real, rest) : real;
      return isWithin(realRoot, full) ? full : null;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return null;
      rest = rest ? join(basename(existing), rest) : basename(existing);
      existing = parent;
    }
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function walk(root: string, dir: string, out: string[], cap: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length > cap) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walk(root, full, out, cap);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

/** Workspace files as sorted POSIX paths relative to `root`, at most `cap` of them. */
export async function listFiles(
  root: string,
  cap = MAX_LIST_ENTRIES,
): Promise<{ paths: string[]; capped: boolean }> {
  let paths: string[];
  if (await isGitRepo(root)) {
    const { stdout } = await run(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    paths = [...new Set(stdout.split("\0").filter(Boolean))];
  } else {
    paths = [];
    await walk(root, root, paths, cap);
  }
  paths.sort();
  const capped = paths.length > cap;
  return { paths: capped ? paths.slice(0, cap) : paths, capped };
}

/** Text content of a file inside `root`, or why it can't be shown. */
export async function readText(
  root: string,
  path: string,
  maxBytes = MAX_READ_BYTES,
): Promise<FilesReadOutput> {
  const target = await resolveInside(root, path);
  if (!target) return { status: "outside" };
  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) return { status: "missing" };
    size = info.size;
  } catch {
    return { status: "missing" };
  }
  if (size > maxBytes) return { status: "too-large" };
  const handle = await open(target, "r");
  try {
    const buffer = await handle.readFile();
    if (buffer.subarray(0, 8000).includes(0)) return { status: "binary" };
    return { status: "ok", text: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}
