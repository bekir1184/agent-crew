# Agent Crew

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code 2.1.293 or newer](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.293-d97757)

A Claude Code mod that shows your subagents above the prompt as a crew of pixel-art Claude critters. Each critter holds the tool it is using, and its row shows how far along it is, how long is left and how many tokens it has used.

<p align="center">
  <img src="docs/crew-states.svg" alt="The crew members: searching with a magnifier, reading a page, writing in a code window, running a command on a laptop, browsing a globe, thinking with an hourglass, getting ready in a hard hat, done with a checkered flag, failed with dizzy eyes, cancelled and asleep" width="100%">
</p>

## Install

Type this at the Claude Code prompt:

```
/plugin install agent-crew --marketplace bekir1184/agent-crew
```

Answer `y` to add the marketplace, then pick a scope: **user** (the first choice) turns it on in every project and every new session; **project** only in the current project. The mod is active right away.

There is nothing to run after that. Whenever Claude starts subagents, the crew appears above the prompt on its own, and it leaves the stage once they are done and you send your next message. The `/crew` command is only for extras: a demo, hiding the crew, or clearing it.

The same in two steps, which also works on older Claude Code builds:

```
/plugin marketplace add bekir1184/agent-crew
/plugin install agent-crew@agent-crew
```

Requires Claude Code **2.1.293 or newer**, with function-hook plugins ("mods"). That API is still early access and may change between releases.

## What it shows

```
AGENT CREW  2 agents working, 1 helper working              12.4k tokens · crew ~0:14 left · 46%

[critter]   EXPLORE  Map the auth flow        Searching  func login(         ▰▰▰▰▱▱▱▱  62%  ~0:06 left  3.1k tok  ▸
[critter]   GENERAL  Write and run the tests  Step 3/5   waiting on 1 helper  ▰▰▰▱▱▱▱▱  50%  ~0:14 left  5.2k tok  ▸
  └ [critter] EXPLORE  Find mock data         Searching  MockUser             ▰▰▱▱▱▱▱▱  30%  ~0:08 left  0.9k tok  ▸
[critter]   PLAN     Plan the refactor        Done                            ▰▰▰▰▰▰▰▰ 100%  took 0:21   2.4k tok  ▸
```

- **One row per subagent.** Columns are aligned to the band's real width, and long text is cut to fit instead of pushing the row around.
- **The critter shows the activity.** It holds the tool for what the agent is doing: a magnifier, a page, a code window, a laptop, a globe or an hourglass. When the agent finishes it raises a checkered flag. A failed agent gets dizzy eyes, a cancelled one falls asleep.
- **Helpers.** A subagent started by another subagent appears indented under its parent, and the parent's row says it is waiting on it.
- **Real steps when available.** If an agent keeps a to-do list (`TodoWrite`, `TaskCreate`, `TaskUpdate`), the bar follows its actual steps ("Step 3/5").
- **Details on demand.** Click anywhere on a row to open a panel under it with:
  - the full task and target
  - the step list
  - a token breakdown
  - the model, and the tool and request counts

  The arrow turns from ▸ to ▾ while the panel is open; click again to close it. Only one panel is open at a time, and the open row and its panel get a dashed yellow frame. In the terminal the arrow is also a button, for keyboards and for terminals that don't report the mouse.
- **Fits your theme.** Text is drawn with Claude Code's own elements and theme colors; the agent types keep their own accent colors so they stay recognizable. The critters, bars and arrows are pixel-art SVG.
- **Calm by design.** The short thinking pauses between tool calls don't make the critter flicker. "Thinking" shows only once it lasts longer than 1.5 seconds.

Works in the desktop app's Code tab and in the terminal. The terminal draws the same columns with text.

## Commands

| Command | What it does |
| --- | --- |
| `/crew` | Show or hide the crew |
| `/crew demo` | Put a demo crew on stage (4 agents and 2 helpers, every outcome) to see the design |
| `/crew clear` | Clear the stage |

When everyone has finished, the crew leaves the stage with your next message. **Hide** hides only the current crew; the next one shows again. The stage holds up to 12 agents; past that, finished ones make room first.

## How the numbers work

**Tokens.** Each row counts the tokens an agent added: input, output and cache writes. Every request also re-reads the whole conversation from the prompt cache, at about a tenth of the input price. Counting those re-reads would make a one-minute agent look like it used hundreds of thousands of tokens, so the row leaves them out. The details panel lists them separately as "re-read from cache".

**Time left.** This is an estimate, worked out on your machine with plain arithmetic. No model is asked, so it costs no tokens.
- Agent Crew remembers the last 20 runs that finished successfully for each subagent type and model, and expects the median of those. With no history for a model, it uses the same type's runs on other models.
- After three runs the details panel also shows the usual range ("usually 0:30–0:50").
- Within the expected time, the number of model requests refines the guess: an agent that works faster than usual gets there sooner.
- When an agent keeps a to-do list, the time per finished step predicts the rest.
- When an agent runs longer than usual, the estimate is redone instead of counting overtime. It looks only at past runs that lasted at least this long and takes their median. If none did, it adds a quarter of the time so far, at least 10 seconds. The details panel marks this "re-estimated".
- With no history at all it assumes one minute and labels it "first estimate".
- The bar follows elapsed ÷ (elapsed + time left), so it agrees with the time column. It never moves backwards: when the estimate is revised upwards, the bar holds still until real progress catches up. It never shows full before an agent is done.

Run history stays on your machine, in the plugin's own storage.

## Performance

The mod is built to stay out of the way of the agents it watches:
- `tool.call` and `turn.step` run for every tool call and model request of every subagent. They never read or write state; they only note what happened in memory, so a subagent's work is never held up.
- A once-a-second ticker writes those notes in a single state update and redraws the band at most once. It stops when no agent is running and starts again when one does.
- Engine-internal loops (compaction, forks) that the mod never saw start are ignored.
- Each SVG carries only the animations it uses, and sprites and bars are cached per state, so most redraws reuse the same strings.
- Every hook only observes and ends in `.catch(...)`, so if the mod has a bug, Claude Code carries on as if it were not installed.
- An agent whose end is never reported is closed using the engine's own agent list, checked every 10 seconds: one the engine reports ended gets that outcome, and one it no longer lists is closed after 30 seconds of silence. An agent the engine still lists as running is left alone however quiet it is, so a long build is never mistaken for a dead agent. Only where that list isn't available does 15 minutes of silence retire an agent.

## Development

```
agent-crew/
├── .claude-plugin/
│   ├── plugin.json        manifest
│   └── marketplace.json   makes this repository installable
├── hooks/
│   ├── hooks.json         points to register.tsx
│   ├── register.tsx       the hooks: session.start, agent.spawn, tool.call, turn.step,
│   │                      turn.complete, prompt.submit, ui.message, ui.render, /crew
│   ├── row-hit.tsx        a transparent layer over each row that turns a click into open/close
│   └── draw.ts            pure logic and pixel art, no engine dependency
├── types/index.d.ts       the $.state contract
├── tests/                 run by `claude plugin test`
└── docs/                  README images
```

Run it from your clone while you work on it:

```bash
claude --plugin-dir .
```

Check and test (Claude Code 2.1.293 or newer):

```bash
claude plugin validate .
claude plugin test .
```

`validate` reads the marketplace file, the manifest and the hooks module in one run.

`draw.ts` doesn't touch the engine, so plain Node 25+ runs it directly (Node strips the TypeScript types). That makes it easy to write the SVGs to files and open them in a browser while you design.

## License

[MIT](LICENSE) © 2026 Bekir Ersever
