# Live View (Paseo plugin)

A Paseo workspace panel that replays agent edits in a VS Code-style view and shows every shell
command in a read-only terminal. See `OVERVIEW.md` for what it does and
`docs/superpowers/specs/2026-11-26-live-view-design.md` for the design.

## Develop

```bash
pnpm install
pnpm test          # vitest: pure logic under client/logic and server/
pnpm typecheck
paseo plugin install "$PWD" --id live-view   # once
paseo plugin reload live-view                # after every change
paseo plugin ls                              # expect: live-view running
paseo plugin logs live-view                  # server-side output
```

Open it in Paseo with ⌘K → **Open Live View**, ideally in a split pane beside the agent chat.

## Layout

| Path | What it is |
| --- | --- |
| `index.client.tsx` | Registers the panel and the Command Center item |
| `index.server.ts` | `files.list` / `files.read` handlers (resolve the workspace folder themselves) |
| `client/useLiveFeed.ts` | Follows every agent's timeline, snapshots files after edits, ticks the player |
| `client/logic/events.ts` | Timeline tool calls → `LiveEvent`s, dedupe |
| `client/logic/reconstruct.ts` | Rebuilds the before-text of an edit |
| `client/logic/pacing.ts`, `player.ts` | Catch-up player: slow motion when calm, stays within 15 s in bursts |
| `client/*.tsx` | File tree, editor, terminal, controls, panel layout |
| `server/files.ts` | File listing and safe reads |
| `client/logic/highlight.ts`, `icons.ts`, `pointer.ts` | Syntax colours, file icons, where the mouse pointer goes |
| `client/logic/review/*` | Review mode: `gh` command detection, diff parsing, merging partial reads, findings, review state |
| `client/logic/thoughts.ts` | Thinking strip lane |
| `client/DiffView.tsx`, `PrFiles.tsx`, `ReviewBar.tsx`, `ThinkingStrip.tsx`, `PointerLayer.tsx` | Review mode, thinking strip and pointer UI |

## Hidden tabs

Live View is meant to sit beside the agent chat. If it is a hidden tab in the same pane, Paseo
may unmount it; activity from that time then appears as history (instantly, not animated) when
you switch back. *Observed behaviour on Paseo 0.17.4: to be confirmed in the manual check.*
