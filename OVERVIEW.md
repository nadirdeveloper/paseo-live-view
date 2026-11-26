Live View is a workspace panel that lets you watch coding agents work, laid out like a small code editor. It shows the workspace's files, jumps to the file an agent is editing and replays the change in slow motion with a moving cursor, and lists every shell command the agents ran with its output and exit code.

## How it works

Agents write each edit in one step, so Live View replays edits after they happen rather than streaming keystrokes. While things are calm it types at a slow, readable speed. When several edits or commands arrive at once it speeds up so it stays within about 15 seconds of the agents. You can pause, choose 0.5×, 1× or 2× speed, or skip straight to the latest state.

It follows every agent in the workspace and labels each change with the agent that made it. When you open the panel, recent activity appears straight away without animation; only new activity is replayed.

## Review mode

When an agent reviews a pull request (for example with a review skill that runs `gh pr diff`), Live View switches to Review mode on its own. A Code / Review switch at the top lets you flip back and forth; once you use it, automatic switching waits until the next review.

- The PR's changed files are listed with their added and removed line counts and a bar showing how much of each file's diff the agent has read so far. When the diff is too long for one command and the agent reads the saved copy in parts, every part it reads is added.
- The selected file's diff is shown in red and green, and a reading highlight and the pointer move through each newly read part.
- Files the agent fetches whole at the PR's head commit open as "reading at PR head".
- When the agent's final report lists findings by severity with `file:line`, each one is pinned under its line, files show coloured finding dots, and the verdict appears at the top.

Review mode only shows what the agent itself saw. It makes no GitHub or Jira requests and does not open the agent's saved files.

## Thinking strip

A strip above the controls types out the agent's latest reasoning and messages as they arrive, keeping the last three. Whether reasoning appears depends on the agent sharing it.

## Subagents

Each agent in the workspace, and each subagent it starts, gets its own replay. A switcher at the top lists them (subagents nested under the agent that started them, with a running, done, idle or failed dot); pick one to watch it, or choose Auto to follow whichever started something most recently. Every replay keeps going in the background, so switching shows exactly where that agent is.

For Claude Code subagents, Live View reads the subagent's own log, which Claude Code writes next to the parent session, and replays its edits, commands, reviews and thinking. It looks only in the project folder that matches the agent's working directory, inside `~/.claude`, `~/.claude-work` and `~/.claude-alt`, and only opens logs that match a subagent the agent actually started. If a log can't be found, the subagent appears with its type, task and status only.

## What it reads

- The activity history of the agents in the current workspace: edits, file writes, shell commands, file reads, reasoning, messages, and sub-agent calls.
- Claude Code subagent logs and their info files, as described above (read-only).
- Files inside the workspace folder, to show the file list and the file around each edit. It never reads files outside the workspace folder, and it skips binary files and files over 1 MiB.

Live View is read-only. It does not change files, run commands, or send anything off your machine.

## Limits

- No syntax colouring.
- Very long command output is trimmed to the last 200 lines.
- Edits made inside Claude Code's own built-in sub-agents appear as a single line rather than a replay.
- If a file changed again before an edit could be replayed, that edit is shown on its own with a note instead of in place.
- Requires Paseo 0.17.4 or later.
