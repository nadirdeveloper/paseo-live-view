Live View is a workspace panel that lets you watch coding agents work, laid out like a small code editor. It shows the workspace's files, jumps to the file an agent is editing and replays the change in slow motion with a moving cursor, and lists every shell command the agents ran with its output and exit code.

## How it works

Agents write each edit in one step, so Live View replays edits after they happen rather than streaming keystrokes. While things are calm it types at a slow, readable speed. When several edits or commands arrive at once it speeds up so it stays within about 15 seconds of the agents. You can pause, choose 0.5×, 1× or 2× speed, or skip straight to the latest state.

It follows every agent in the workspace and labels each change with the agent that made it. When you open the panel, recent activity appears straight away without animation; only new activity is replayed.

## What it reads

- The activity history of the agents in the current workspace (edits, file writes, shell commands, and sub-agent calls).
- Files inside the workspace folder, to show the file list and the file around each edit. It never reads files outside the workspace folder, and it skips binary files and files over 1 MiB.

Live View is read-only. It does not change files, run commands, or send anything off your machine.

## Limits

- No syntax colouring.
- Very long command output is trimmed to the last 200 lines.
- Edits made inside Claude Code's own built-in sub-agents appear as a single line rather than a replay.
- If a file changed again before an edit could be replayed, that edit is shown on its own with a note instead of in place.
- Requires Paseo 0.17.4 or later.
