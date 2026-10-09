# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-09

### Added

- Each row names the model its agent runs on, under the type ("Opus 5.5",
  "Haiku 4.5"); Claude's own model sits beside the title, and the terminal
  shows a short name when there is room.

### Changed

- `/crew demo` is a 30-second show timed for a screen recording: Claude starts
  alone, then three agents arrive one by one and a helper joins, so the band
  fits on screen; the crew works, thinks, one agent asks for approval, and
  everyone ends with a flag.
- While the demo is on stage, the prompt box shows the demo's own English hint
  (`/crew clear`) instead of Claude Code's guess at your next message, so a
  recording shows nothing personal; suggestions are untouched otherwise.
- The type and model under it are drawn small on the desktop, and a row's task
  text uses the room the row really has instead of being cut early.
- The README is shorter and visual, led by a recording of the demo, with an
  animated image per feature; a small site (`site/`) shows the same.
- Token figures on rows, the title and the thin line count only the work
  itself, input and output. Cache writes and re-reads have their own line in
  the details panel, so a long conversation picked up after its cache expired
  no longer shows a sudden jump of hundreds of thousands of tokens.

## [0.2.0] - 2026-10-09

### Added

- Claude's own line: while the main conversation works, the framed title shows
  its activity, time and tokens. Alone it reads AGENT, and when the turn ends it
  shrinks to a thin line with the turn's final numbers and an arrow for details;
  subagents join below it as AGENT CREW. Setting "Show Claude's own work", on
  by default.
- Approval state: an agent stopped at a permission prompt shows "Needs
  approval" with the tool, a critter with a question bubble, and the title
  counts the agents waiting on you.
- Optional cost estimate (setting "Show estimated cost", off by default): a ≈
  dollar figure per row, for the crew in the title, and broken down in the
  details panel, from each model's list prices.
- The title row has its own arrow that folds the subagent rows away and back; each
  new crew starts with its rows open.
- Status line summary while the crew is hidden with `/crew`.
- Health signals: slow tool calls (over 30 s) show their time, and agents with
  no activity for 2 minutes are marked "Quiet".
- The details panel lists an agent's last five tool calls, failed ones marked,
  and the files it changed and read.
- Secrets in commands, URLs and task text are masked as `•••`.

### Changed

- Thinking is animated: a crew member keeps taking turns between the
  hourglass, a thought cloud with a question mark and a lightbulb that lights
  up, out of step with the rest of the crew.
- The terminal leads each row with a dot colored by the state instead of a
  text face, and its arrows take letter hotkeys (`h` for the title, `a`, `b`,
  … for the rows) once `ctrl+x tab` gives the crew the focus.
- `/clear` also clears a finished crew.

## [0.1.1] - 2026-10-09

### Changed

- A row's details now open from an arrow button at its end (▸ / ▾) instead of
  a click anywhere on the row. The desktop delivers raw pointer events to
  plugin layers unreliably (presses dropped, releases doubled), so clicks were
  missed or undone; a button works every time, and with the keyboard too.
- The title row is framed in Claude's color. The Clear and Hide buttons are
  gone: `/crew` hides and `/crew clear` clears.

### Fixed

- The "doing" column no longer wraps onto a second line on the desktop.
- Rows use more of the available width, so task names are cut less.

## [0.1.0] - 2026-10-09

### Added

- One aligned row per subagent above the prompt: a pixel-art crew member holding
  the tool it is using, its task, what it is doing now, a progress bar, the time
  left and the tokens it used.
- Helpers (subagents started by a subagent) shown indented under their parent.
- Real step progress when an agent keeps a to-do list (TodoWrite, TaskCreate,
  TaskUpdate).
- Time estimates learned per subagent type and model (median of the last 20
  runs, with the usual range after three runs). Agents that run long are
  re-estimated from past runs that lasted as long, instead of showing overtime.
  Estimates are local arithmetic and cost no tokens.
- A details panel per row: full task, steps, token breakdown, model, tool and
  request counts. Click anywhere on a row to open it (▸ turns to ▾); one panel
  at a time, framed with a dashed yellow border.
- Done, failed and cancelled states: checkered flag, dizzy eyes, asleep.
- Terminal and desktop rendering; text follows your theme.
- `/crew`, `/crew demo` and `/crew clear` commands.
- Built to stay out of the agents' way: tool calls and model requests are only
  noted in memory; a one-second ticker writes them in a single update and
  redraws at most once. Engine-internal loops are ignored, SVGs carry only the
  animations they use, and sprites and bars are cached per state.
- Agents whose end is never reported are closed from the engine's own agent
  list, with the outcome it reports; a quiet agent it still lists as running is
  never retired. Resumed subagents run again. Every hook falls back to Claude
  Code's own behavior on error.

[Unreleased]: https://github.com/bekir1184/agent-crew/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bekir1184/agent-crew/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bekir1184/agent-crew/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/bekir1184/agent-crew/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bekir1184/agent-crew/releases/tag/v0.1.0
