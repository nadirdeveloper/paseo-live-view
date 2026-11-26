import { existsSync, readdirSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Entry } from "../shared/subagents";
import { createNormalizer } from "./transcript";


export type SubagentMeta = { agentType?: string; description?: string; spawnDepth?: number; background: boolean };
export type TailStatus = "running" | "done" | "idle";

/** Transcripts this plugin process has located; `tail` refuses anything else. */
const allowed = new Set<string>();

export function isAllowedPath(path: string): boolean {
  return allowed.has(path);
}

/** Claude names a project folder after its cwd with every non-alphanumeric character as "-". */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Claude Code config folders to search: `$CLAUDE_CONFIG_DIR` (if set), `~/.claude`, and any other
 * `~/.claude-*` folder that has a `projects/` folder (extra accounts). Folders of other tools that
 * merely start with ".claude" (no `projects/`) are skipped.
 */
export function configDirs(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const isConfig = (dir: string) => existsSync(join(dir, "projects"));
  const dirs: string[] = [];
  const custom = env.CLAUDE_CONFIG_DIR;
  if (custom && isConfig(custom)) dirs.push(custom);
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    // no home listing: nothing else to search
  }
  for (const name of names.sort()) {
    if (name !== ".claude" && !name.startsWith(".claude-")) continue;
    const dir = join(home, name);
    if (isConfig(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Find the transcript of the subagent started by tool call `toolUseId`, only in the cwd's project folder. */
export async function locate(home: string, toolUseId: string, cwd: string): Promise<{ path: string; meta: SubagentMeta } | null> {
  for (const dir of configDirs(home)) {
    const project = join(dir, "projects", encodeCwd(cwd));
    let sessions: string[];
    try {
      sessions = await readdir(project);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const folder = join(project, session, "subagents");
      let files: string[];
      try {
        files = await readdir(folder);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".meta.json")) continue;
        try {
          const meta = JSON.parse(await readFile(join(folder, file), "utf8")) as Record<string, unknown>;
          if (meta.toolUseId !== toolUseId) continue;
          const path = join(folder, file.replace(/\.meta\.json$/, ".jsonl"));
          allowed.add(path);
          return {
            path,
            meta: {
              agentType: typeof meta.agentType === "string" ? meta.agentType : undefined,
              description: typeof meta.description === "string" ? meta.description : undefined,
              spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined,
              background: meta.requestShape === "background",
            },
          };
        } catch {
          // unreadable meta: skip
        }
      }
    }
  }
  return null;
}

async function isFinished(metaPath: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(metaPath, "utf8")) as { finished?: boolean }).finished === true;
  } catch {
    return false;
  }
}

/**
 * Stream a transcript: existing lines, then new complete lines as they're appended. Reports
 * running → idle (no new lines for idleMs) → running again, and done when meta says finished.
 * Ends at done, after endMs with nothing new, or when `signal` aborts.
 */
export async function tail(
  path: string,
  onEntries: (entries: Entry[]) => void,
  onStatus: (status: TailStatus) => void,
  signal: AbortSignal,
  opts: { pollMs?: number; idleMs?: number; endMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 500;
  const idleMs = opts.idleMs ?? 3 * 60_000;
  const endMs = opts.endMs ?? 10 * 60_000;
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  const normalizer = createNormalizer();
  let offset = 0;
  // Bytes of a line still being written (kept as bytes so a split character isn't garbled).
  let partial = Buffer.alloc(0);
  // Quiet time counts from the file's last write, so an old interrupted subagent starts as idle.
  let lastNew = await stat(path).then((s) => s.mtimeMs).catch(() => Date.now());
  let firstRead = true;
  let status: TailStatus = "running";
  onStatus("running");

  const readNew = async () => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      const bytes = Buffer.concat([partial, buffer]);
      const end = bytes.lastIndexOf(0x0a);
      // A line without its newline yet waits for the rest.
      partial = end === -1 ? bytes : bytes.subarray(end + 1);
      const lines = end === -1 ? [] : bytes.subarray(0, end).toString("utf8").split("\n");
      const entries = normalizer.push(lines);
      // What was already in the file isn't new activity; only later writes are.
      if (!firstRead) lastNew = Date.now();
      firstRead = false;
      if (status === "idle") {
        status = "running";
        onStatus("running");
      }
      if (entries.length > 0) onEntries(entries);
    } finally {
      await handle.close();
    }
  };

  while (!signal.aborted) {
    await readNew();
    if (await isFinished(metaPath)) {
      await readNew();
      onStatus("done");
      return;
    }
    const quiet = Date.now() - lastNew;
    if (quiet >= endMs) return;
    if (quiet >= idleMs && status !== "idle") {
      status = "idle";
      onStatus("idle");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
