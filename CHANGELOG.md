# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/bekir1184/agent-crew/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bekir1184/agent-crew/releases/tag/v0.1.0
