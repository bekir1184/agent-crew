<h1 align="center">Agent Crew</h1>

<p align="center"><b>Your subagents, as a tiny pixel crew above the prompt.</b><br>
See who is doing what, how far along they are, and how long is left.</p>

<p align="center">
  <img src="docs/demo.gif" alt="Agent Crew in the Claude desktop app: Claude starts alone on the AGENT line, then a Plan, an Explore and a General agent arrive one by one with a helper; they search, read, think and ask for approval, their bars fill up, and each raises a checkered flag when done" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.293-d97757" alt="Claude Code 2.1.293 or newer">
</p>

## Install

```
/plugin install agent-crew --marketplace bekir1184/agent-crew
```

That's it. The crew shows up by itself whenever Claude is at work. Want a look right now? Type `/crew demo`.

**Costs nothing.** Agent Crew never calls a model and never touches your prompts: it only watches.

## Claude, live

While Claude works, the framed line shows what it's doing this very second. When the turn ends it shrinks to one quiet line with the totals. Press the arrow to see what happened.

<img src="docs/agent-line.svg" alt="The AGENT line: searching, reading, thinking, writing, running tests, then a thin line: done, last turn 0:37, 5.6k tokens, 9 tools" width="100%">

## The crew

When Claude hands work to subagents, they line up below, one row each. Each row names the model it runs on, so you can tell Opus from Haiku at a glance. Helpers started by a subagent tuck in under their parent. Too busy? The arrow on the title folds them away, and the – button shrinks the whole band to one plain line (it stays that way in later sessions until you press ▸). Cancelled agents leave the stage right away. The ⇥ button moves the whole crew into a narrow pane beside the conversation, one stacked card per agent; ⇤ (or closing the pane) brings it back.

Each critter holds the tool it's using:

<img src="docs/crew-states.svg" alt="Searching with a magnifier, reading a page, writing in a code window, running a command on a laptop, browsing a globe, getting ready in a hard hat, done with a checkered flag, failed with dizzy eyes, cancelled and asleep" width="100%">

## Thinking...

Thinking is where agents spend most of their time, so the critters keep it lively: an hourglass, a thought cloud with a question mark, a lightbulb that lights up. Each one at its own pace.

<img src="docs/thinking.svg" alt="Three critters thinking: one turns an hourglass, one fills a thought cloud with a question mark, one lights a bulb and hops" width="100%">

## It needs you

When an agent stops to ask for permission, it says so: a yellow question bubble, and the title tells you how many are waiting.

<img src="docs/approval.svg" alt="A row turns yellow with Needs approval: Bash rm -r build, then carries on once approved" width="100%">

## The details

Every row has an arrow. It opens everything the row had no room for: the full task, its to-do list, the files it touched, and its tokens.

<img src="docs/details.svg" alt="A row opens into a panel: task, current step, checklist, changed files, token breakdown and run summary" width="100%">

## How long is left?

No model is asked and no tokens are spent: Agent Crew simply remembers how long this kind of agent took before.

<img src="docs/estimate.svg" alt="Past run times, the middle one picked, a live countdown, and a re-estimate when the run goes long" width="100%">

## Honest tokens

A row shows what the agent's own work took: what it read in and what it wrote. Nothing else.

Claude also keeps the whole conversation in a cache and re-reads it on every request. And after a break the cache expires, so the next request writes the whole conversation into it again, which on a long conversation can be hundreds of thousands of tokens at once. Neither is the agent's work, so neither inflates the row: both sit in the details panel, on their own line.

Turn on **Show estimated cost** in the settings and each row also gets a ≈ dollar figure.

## Commands

| | |
| --- | --- |
| `/crew` | Hide or show the crew |
| `/crew demo` | A 30-second show: Claude starts alone, the crew arrives, thinks, asks you, and ends with all flags up |
| `/crew clear` | Clear the stage |

**Settings** live in `/plugin configure agent-crew@agent-crew`: show Claude's own line (on), show estimated cost (off).

**In the terminal** there's no pixel art, just a colored dot per row. Press `ctrl+x tab` to reach the crew, then the letter on an arrow: `h` for the title, `z` to minimise, `y` to move to the side pane, `a`, `b`, `c` for the rows.

## Development

Run it from a clone, then check and test it (Claude Code 2.1.293 or newer):

```bash
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

The animated images in `docs/` and `site/` are drawn from the mod's own pixel art: `node scripts/docs.mjs` (Node 25+) redraws them.

---

<p align="center">Made for fun. <a href="LICENSE">MIT</a> © 2026 Bekir Ersever</p>
