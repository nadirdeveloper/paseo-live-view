import { appendFile, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { Entry } from "../shared/subagents";
import { configDirs, encodeCwd, isAllowedPath, locate, tail } from "./subagents";

let home: string;
const cwd = "/Users/me/work/my.app";

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "live-view-home-")));
});

async function subagent(configDir: string, projectCwd: string, id: string, meta: object, lines: string[] = []) {
  const dir = join(home, configDir, "projects", encodeCwd(projectCwd), "session-1", "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  await writeFile(join(dir, `agent-${id}.jsonl`), lines.map((l) => l + "\n").join(""));
  return join(dir, `agent-${id}.jsonl`);
}

const assistantTool = (id: string, name: string, input: object) =>
  JSON.stringify({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });

describe("encodeCwd and configDirs", () => {
  test("replaces slashes and dots with dashes", () => {
    expect(encodeCwd("/Users/me/work/my.app")).toBe("-Users-me-work-my-app");
  });

  test("only the three known config folders that exist", async () => {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".claude-work"));
    await mkdir(join(home, ".claude-mem"));
    expect(configDirs(home)).toEqual([join(home, ".claude"), join(home, ".claude-work")]);
  });
});

describe("locate", () => {
  test("finds the subagent by its call id in the cwd's project folder", async () => {
    const path = await subagent(".claude-work", cwd, "a1", { toolUseId: "toolu_1", agentType: "Explore", description: "find env", spawnDepth: 1, requestShape: "background" });
    expect(await locate(home, "toolu_1", cwd)).toEqual({
      path,
      meta: { agentType: "Explore", description: "find env", spawnDepth: 1, background: true },
    });
    expect(isAllowedPath(path)).toBe(true);
  });

  test("ignores matches in other projects and in other ~/.claude* folders", async () => {
    await subagent(".claude", "/Users/me/other", "a2", { toolUseId: "toolu_2" });
    await subagent(".claude-mem", cwd, "a3", { toolUseId: "toolu_2" });
    expect(await locate(home, "toolu_2", cwd)).toBeNull();
  });

  test("paths never located are not allowed", () => {
    expect(isAllowedPath("/etc/passwd")).toBe(false);
    expect(isAllowedPath(join(home, ".claude.json"))).toBe(false);
  });
});

describe("tail", () => {
  test("streams existing lines, then appended lines, never a half line, and ends when finished", async () => {
    const path = await subagent(".claude", cwd, "t1", { toolUseId: "toolu_t" }, [assistantTool("c1", "Read", { file_path: "/w/a" })]);
    const got: Entry[] = [];
    const statuses: string[] = [];
    const controller = new AbortController();
    const done = tail(path, (e) => got.push(...e), (s) => statuses.push(s), controller.signal, { pollMs: 20, idleMs: 10_000, endMs: 10_000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(got.map((e) => (e.kind === "tool" ? e.callId : e.kind))).toEqual(["c1"]);
    const line = assistantTool("c2", "Bash", { command: "ls" });
    await appendFile(path, line.slice(0, 20));
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toHaveLength(1);
    await appendFile(path, line.slice(20) + "\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(got.map((e) => (e.kind === "tool" ? e.callId : e.kind))).toEqual(["c1", "c2"]);
    await writeFile(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ toolUseId: "toolu_t", finished: true }));
    await done;
    expect(statuses[0]).toBe("running");
    expect(statuses[statuses.length - 1]).toBe("done");
  });

  test("reports idle when nothing new arrives", async () => {
    const path = await subagent(".claude", cwd, "t2", { toolUseId: "toolu_i" });
    const statuses: string[] = [];
    const controller = new AbortController();
    const done = tail(path, () => {}, (s) => statuses.push(s), controller.signal, { pollMs: 10, idleMs: 50, endMs: 10_000 });
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await done;
    expect(statuses).toContain("idle");
  });
});
