import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../shared/files";
import { MAX_READ_BYTES, listFiles } from "./files";

export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** text null = not kept (binary, too big, or over the total budget); such files never report changes. */
type Entry = { text: string | null; mtimeMs: number; size: number };
type Root = { real: string; entries: Map<string, Entry>; bytes: number; chain: Promise<unknown> };

export type Snapshots = {
  prime(root: string): Promise<void>;
  changes(root: string): Promise<FileChange[]>;
  remember(root: string, absPath: string, text: string): void;
};

/**
 * In-memory copies of a workspace's text files, so edits made by shell commands (or any tool) can be
 * shown with their real before and after text. Nothing is written anywhere.
 */
export function createSnapshots(limits: { maxFileBytes?: number; maxTotalBytes?: number } = {}): Snapshots {
  const maxFile = limits.maxFileBytes ?? MAX_READ_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_SNAPSHOT_BYTES;
  const roots = new Map<string, Promise<Root>>();

  /** Text of a file if it may be kept, else null. */
  async function load(state: Root, path: string, size: number, replacing: number): Promise<string | null> {
    if (size > maxFile || state.bytes - replacing + size > maxTotal) return null;
    try {
      const buffer = await readFile(path);
      if (buffer.subarray(0, 8000).includes(0)) return null;
      return buffer.toString("utf8");
    } catch {
      return null;
    }
  }

  function store(state: Root, path: string, entry: Entry): void {
    const old = state.entries.get(path);
    if (old?.text != null) state.bytes -= old.size;
    if (entry.text != null) state.bytes += entry.size;
    state.entries.set(path, entry);
  }

  async function listed(state: Root): Promise<string[]> {
    const { paths } = await listFiles(state.real);
    return paths.map((p) => join(state.real, p));
  }

  async function build(root: string): Promise<Root> {
    const state: Root = { real: await realpath(root), entries: new Map(), bytes: 0, chain: Promise.resolve() };
    for (const path of await listed(state)) {
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        store(state, path, { text: await load(state, path, info.size, 0), mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Vanished while listing.
      }
    }
    return state;
  }

  function stateFor(root: string): { state: Promise<Root>; fresh: boolean } {
    const existing = roots.get(root);
    if (existing) return { state: existing, fresh: false };
    const state = build(root);
    roots.set(root, state);
    state.catch(() => roots.delete(root));
    return { state, fresh: true };
  }

  async function diff(state: Root): Promise<FileChange[]> {
    const out: FileChange[] = [];
    const now = new Set(await listed(state));
    for (const path of now) {
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      const old = state.entries.get(path);
      if (old && old.mtimeMs === info.mtimeMs && old.size === info.size) continue;
      const replacing = old?.text != null ? old.size : 0;
      const text = await load(state, path, info.size, replacing);
      if (!old) {
        if (text !== null) out.push({ path, before: null, after: text });
      } else if (old.text !== null && text !== null && text !== old.text) {
        out.push({ path, before: old.text, after: text });
      }
      store(state, path, { text, mtimeMs: info.mtimeMs, size: info.size });
    }
    for (const [path, old] of state.entries) {
      if (now.has(path)) continue;
      try {
        await stat(path);
        continue; // Still there, just no longer listed (e.g. newly ignored).
      } catch {
        if (old.text !== null) out.push({ path, before: old.text, after: null });
        if (old.text != null) state.bytes -= old.size;
        state.entries.delete(path);
      }
    }
    return out;
  }

  return {
    async prime(root) {
      await stateFor(root).state;
    },
    async changes(root) {
      const { state: pending, fresh } = stateFor(root);
      const state = await pending;
      if (fresh) return [];
      // One check at a time per workspace, so two agents never get the same change.
      const run = state.chain.then(() => diff(state));
      state.chain = run.catch(() => undefined);
      return run;
    },
    remember(root, absPath, text) {
      void roots.get(root)?.then((state) => {
        // mtime -1 makes the next check re-read the file, see the same text, and stay quiet.
        store(state, absPath, { text, mtimeMs: -1, size: Buffer.byteLength(text) });
      });
    },
  };
}
