# swarm

A Claude Code mod plus a skill for leading a self-organising **agent team**: teammates message each
other directly with SendMessage, and the lead sets the goal and is woken only when it is needed.

**Status: experimental.** Needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and Claude Code
≥ 2.1.287; built and tested against **2.1.302**. Mod events and methods change between releases.

## For AI agents

This section is written for AI agents: orchestrators looking for a way to lead a Claude Code agent
team. Humans: skip to [For humans](#for-humans).

**What it does for you as the lead.** When you orchestrate an agent team, every message a teammate
sends you, every idle notice and every protocol message (`[PROPOSE]`, `[CLAIM]`, `[HANDOFF]`,
`[REVIEW]`) costs you a full turn over your whole context. This mod sits inside Claude Code and
keeps that traffic out of your context budget: coordination happens between teammates, and you hear
only `@lead` mentions, `[ASK]`, `[BLOCK]`, `[DONE]`, untyped text, idle notices with a failure reason
and real alarms. It runs in Claude Code's own
hooks, with no extra runtime, server or queue. It also:

- stamps every teammate-to-teammate message with one global order (`#412 · 17:04:12`), so a
  duplicate `[CLAIM]` is settled by the lower stamp, and answers each build or research claim: the
  slice is the claimant's, or who holds it;
- hands a released slice to the teammate waiting for it, so a slice such as `merge-lock` works as
  a lock and code is merged one slice at a time;
- asks a teammate whose code name another teammate already uses to pick another;
- nudges the claim holder when the swarm goes quiet, and wakes you only if that does not help;
- tells you when a deliverable has no builder;
- wakes a teammate when the file its background command writes changes (`[WAIT] <path>`) or at a
  time (`[WAIT] until <ISO time>`), so nobody polls;
- gives you one tool, `stop_swarm`, that stops every live teammate or the ones you name;
- writes every message to `.swarm/log.jsonl` and the team to `.swarm/roster.json`, which you can read.

**Install and check** (shell; then start a new session):

```bash
claude plugin install agent-swarm --marketplace rahimi/claude-code-swarm
claude plugin list                      # agent-swarm is listed and enabled
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

In the session, `/swarm status` answers with one line (`swarm: yes/no`, `quiet: on`, the log path).
Without installing: `git clone https://github.com/rahimi/claude-code-swarm` and start
`claude --plugin-dir ./claude-code-swarm`.

**When to use it.** A team of 3–7 teammates under `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` working
on research, review, exploration or a creative build, or code cut into slices that each get their
own git worktree and merge through `merge-lock`. For a single fix list, one builder with
independent reviewers did better (see [What we measured](#what-we-measured)).

**Measured benefit.** In a 7-agent release review (2026-10-14) the lead was woken once while 61 messages to it
were held. In an 18-agent review (2026-10-17) slices worked twice went from 6 and 8 of 21 to 0 once claimants
waited for the mod's answer; the lead was woken 1.7 times per agent. Six teammates building 12 slices of this
mod (2026-10-18) merged 15 times through `merge-lock` with 0 overlaps. Details: [What we measured](#what-we-measured).

**What you can do yourself as the lead.**

- Read `.swarm/roster.json` (agents, code names, `claims`, `deliverables`, `waits`) and
  `.swarm/log.jsonl` (one JSON line per message or event, with `from`, `to`, `summary`, `type`;
  `stamp` on teammate-to-teammate messages).
- Put one `Deliverable: <path>` line per artefact in each spawn prompt; the mod tells you when one
  has no builder.
- Call `stop_swarm` (`mcp__agent-swarm__stop_swarm`, input `{ names?: string[] }`) when the work is
  done. It answers one line: who stopped, who failed and why.
- Run `claude -p "/swarm status"` from a shell for the one-line state where no pane draws.

**The instructions for the lead** are the skill `swarm-protocol` (`agent-swarm:swarm-protocol`,
[skills/swarm-protocol/SKILL.md](skills/swarm-protocol/SKILL.md)): the brief, self-chosen code
names, `[TYPE] subject` messages, claims, reviewer veto, `[LOCK]`, `[WAIT]`, code merged one slice
at a time through `merge-lock`, announced cuts, and a fresh agent for the final synthesis. Load
it before you spawn the team, e.g.
`Use the swarm-protocol skill. Goal: … Budget: 4 agents, 30 min. Kill criterion: … Done when: …`.

**Search terms.** Claude Code agent teams, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, multi-agent
orchestration, swarm, team lead, SendMessage, TaskStop, claims, lead wakes, Claude Code mod, plugin.

Every behaviour of the mod, exactly: [REFERENCE.md](REFERENCE.md). Changes per version:
[CHANGELOG.md](CHANGELOG.md).

## For humans

<!-- film -->
https://github.com/user-attachments/assets/6c096b84-152b-4982-863a-38c02b2a3531

### The pane

`/swarm` opens a pane with two looks. **Look A** (the default, key `1`) is the working view: one
card per teammate with its state, time in it, current action and tool-call count, the file it last
touched, and a bar of its tool calls and messages over time; the claim cards; the lead's wakes,
delivered and held; the message list, refused spawns among them. **Look B** (key `2`) shows the team
as a star map around the lead, each message flying as a comet, for watching and demos. Both draw in
any 24-bit colour terminal and add pictures where the terminal draws them (`/swarm level auto|basic|rich`).

```
◉ S W A R M  LIVE · t1–t2                         T+6:12  01:21:40  ● live
A G E N T S                    2 · 1 running   C L A I M S
▌Atlas t1          ↑3 ↓4 opus     ╭ src/parser.ts ─────────── BUILDING ╮
▌● RUNNING 0:42  ✎ src/parser.ts  │ build Atlas                        │
▌▁▃█▂▁▁▁▅▂▁▁▁▁▃                   │ review ◦Sage                       │
▌Sage t2          ↑2 ↓3 sonnet    ╰────────────────────────────────────╯
▌● IDLE 2:03  ◦ README.md
▌▁▂▁▁▄▁▁▁▁▁▁▁▁▁
LEAD  ▲ 2 woken  ▽ 5 held back
M E S S A G E S
01:21:40 Atlas → Sage   HANDOFF  src/parser.ts
01:17:02 Sage  → Atlas  CLAIM    review src/parser.ts
```

A teammate that joins slides in (look A) or fades in (look B), one that leaves greys out, and the
header says `+ joined Kite` or `− left t2` for 10 s. In the live pane, pressing a live agent's name shows the last lines
of its transcript and a field to message it: type, Enter sends. The text list shows a
subagent that a teammate spawned under that teammate.

`/swarm replay .swarm/log.jsonl` plays a finished run back in the pane. While a swarm runs, the
status line reads `◇ swarm 3 live · 1 done`; when it ends, a toast gives its totals
(`swarm stood down: 4 agents · 52 messages · 12m · lead woken 3 (0.8/agent), held 18`).

### Install

One session: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --plugin-dir <path to this directory>`.

Permanently (Claude Code 2.1.287+), from your terminal:

```
claude plugin install agent-swarm --marketplace rahimi/claude-code-swarm
```

or inside Claude Code:

```
/plugin marketplace add rahimi/claude-code-swarm
/plugin install agent-swarm@claude-code-swarm
```

Look B's rich sky uses a python with numpy for smooth motion: the python the `skyPython` setting names (in `/config`); with it empty, `python3` from PATH, else `uv run --no-project --with numpy python` when `uv` is on PATH. Without one look B draws its basic sky and says why (`/swarm status` too). Nothing else needs Python.

Add `.swarm/` to the project's `.gitignore`.

### Use

```
/swarm                     open the pane
/swarm wake all|mentions|digest|off
/swarm quiet on|off        lead filter, default on
/swarm stall <minutes>     0 turns the watchdog off
/swarm claim <minutes>     claim watchdog delay, 0 turns it off
/swarm level auto|basic|rich  pane level, default auto
/swarm deliverable <path>  adds a deliverable the claim watchdog checks for a builder
/swarm status              one line of text (works where nothing draws, e.g. claude -p)
/swarm stop all|<name>     stops every live teammate, or one (team or code name), with TaskStop
/swarm say <agent> <text>  sends a live agent (team or code name) `swarm: the user says: <text>`
/swarm replay <log.jsonl> [--look A|B] [--level basic|rich] [--speed N] [--from <ISO>] [--to <ISO>]
/swarm replay stop
```

`/swarmctl` is a second name for the same command, for sessions where another plugin also registers `/swarm`.

**If another plugin already uses `/swarm`**, this one still loads and answers on `/swarmctl`;
`/swarmctl status` and the `/swarmctl` help say `/swarm is taken by <plugin>; use /swarmctl`. In an
interactive session it asks you once, a second after start (or after the lead's turn ends): keep
both (stored, never asked again), see the command that removes the other plugin, or ask again next
session. It never uninstalls anything. Two plugins with the same name cannot both load.

Wake mode, the lead filter, stall and claim minutes and the pane level persist in the plugin's
store across sessions. `replay` plays a recorded `.swarm/log.jsonl` in the pane at `--speed`
(default 30×, a quiet stretch at most 1.5 s), one run per team (teammates that messaged each
other, from 30 s before their first peer message to their last line before 30 min without one, so a later
team reusing their names is its own run); without `--from`/`--to` it plays the
most recent run; its reply lists the runs with their `--from`/`--to`, `▶` on the one playing. Each agent of the run shows from its JOIN line, else its first log line, sent or received, so a teammate spawned late appears when it does. A replay sends nothing.
A finished replay holds its last frame for 3 s, marked `replay finished`, then the pane shows the live view.
When a live team spawns a teammate or sends a peer message during a replay, the header says `live swarm running` and a `[ live ]` button (`0`) stops the replay and shows it.
Start a swarm by asking the lead to use the `swarm-protocol` skill, e.g.
`Use the swarm-protocol skill. Goal: … Budget: 4 agents, 30 min. Kill criterion: … Done when: …`.

### What we measured

One project, a handful of runs: treat these as data points.

- **Benchmark.** On one fix list (2026-10-12), a builder with independent reviewers beat the swarm: peer
  reviewers inside the swarm shared the builders' blind spots. The swarm was the fastest and the
  cheapest, and the best at research. A 17-minute swarm review produced 21 findings; of 10 checked,
  6 held, 3 held with the impact overstated, 1 was trivial, 0 were wrong.
- **Claims.** In an 18-agent review swarm (15 Haiku, 3 Sonnet, 2026-10-17), 6 of 21 slices were worked twice in
  the first run and 8 in the second: a busy teammate reads the mod's answer only when it goes idle.
  After the skill's rule to end the turn after a claim and start on the mod's `is yours`, 0 of 21
  were, and the lead was woken 1.7 times per agent.
- **Building code.** Six teammates (four Opus, one Sonnet, one Fable) built 12 slices of this mod in
  40 minutes (2026-10-18), each slice in its own worktree: 15 merges through `merge-lock`, 0 overlapping, tests
  green after every merge (265 to 280), no slice built twice, and reviews that caught real defects.
  Given only a goal and no slice list, a second team of six (2026-10-19) cut the work into 4 slices within about
  a minute of their hellos and merged 6 times in 29 minutes.
- **Film trial.** A four-agent swarm made the owner's favourite film. A single agent tied it at
  about 1/3 of the cost.

### Wake modes, and why the default is `mentions`

The team mailbox **already delivers every message addressed to the lead** (and idle
notifications) as a new lead turn. Waking the lead again for those would double each one, so
no mode ever wakes for a message to or from the lead. The modes govern only
**teammate-to-teammate** traffic, which the lead otherwise never sees:

| Mode | Wakes the lead |
|---|---|
| `mentions` (default) | for peer messages containing `@lead`, `@orchestrator`, `@main` or `@team-lead`, coalesced over 3 s |
| `all` | for every peer message, coalesced over 10 s so a burst is one wake |
| `digest` | at most once per 60 s, with a list of the new peer messages |
| `off` | never (the watchdog still runs unless `/swarm stall 0`) |

Why not `all`: every wake is a full lead turn over the lead's whole context. With 4 chatty
teammates, `all` turns a peer conversation into N extra lead turns, which multiplies cost and
pulls the lead back into relaying, the opposite of a self-organising swarm. `mentions` keeps
the lead out until a teammate asks for it; `digest` is the middle ground for watching.

A wake is never submitted while the lead is mid-turn: it waits in the queue and goes out
250 ms after the lead's turn completes. Per the 2.1.299 types, `$.prompt.submit` from a plugin
"runs once idle" and resolves when its turn starts, so the mod never awaits it inside a hook
(a `session.receive` hook awaiting its own submit hangs) and sends one wake at a time.

Claude Code's own `TeammateIdle` and `TaskCompleted` hooks keep a teammate working, or a task
open, at the moment it would stop; use them for hard gates such as "tests pass before you
stop". The mod covers what they cannot: waking an idle teammate later, and the lead's load.

### Reference

[REFERENCE.md](REFERENCE.md) describes every part exactly: [logging and order stamps](REFERENCE.md#logging-and-order),
[roster and teams](REFERENCE.md#roster-and-teams), [claims and watchdogs](REFERENCE.md#claims-and-watchdogs),
[lead wakes](REFERENCE.md#lead-wakes), [the pane](REFERENCE.md#the-pane) and
[stopping and the protocol skill](REFERENCE.md#stopping-and-the-protocol-skill).

### Known limitations

- Split-pane (tmux/iTerm2) teammates run in their own processes; their messages do not reach the
  mod. Use the default in-process mode.
- Claims are informed, never enforced: a teammate that starts before the mod's answer can
  duplicate work.
- A team that goes quiet for more than 30 minutes replays as two runs.
- Some fields it reads (the task list, idle reasons, agent names) are undocumented; where one is
  missing the pane shows `–` or `open tasks: unknown`.
- Built against Claude Code 2.1.302; mod events and methods change between releases.

### Develop

From this directory:

```bash
claude plugin validate --strict .
claude plugin test
python3 -B -m unittest discover -s tests -p 'test_*.py'   # the sky renderer's motion (needs numpy)
```

To typecheck: `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which is not in
the repo. Claude Code writes `.claude-plugin/types/` each time it loads a mod from a folder you
own (as the header of the written types says), so run `claude --plugin-dir .` once, then
`npx tsc --noEmit`.

`hooks/core.ts` holds every rule as plain functions (log, dedupe, roster, wake policy, stall,
pane text); `hooks/replay.ts` the teams, runs and the scene the looks draw; `hooks/look-a.ts`
and `hooks/look-b.ts` the two looks; `hooks/pane.ts` the pane's stage, live and replay;
`hooks/register.ts` wires them to events; `hooks/looks.ts`, `hooks/grid.ts` and `hooks/pixels.ts`
are the shared drawing helpers (palettes, the cell grid, the pixel canvas); `hooks/pane-draw.ts`
cuts a frame into Rasters and Images; `hooks/sidecar.ts` runs `hooks/sky.py`, the look B sky
renderer. `tests/core.test.ts` pins the rules, `tests/register.test.ts` drives the hooks through
the test kit with a mock clock, `tests/replay.test.ts` covers the looks and the replay,
`tests/pane.test.ts` the pane, `tests/sky.test.ts` the renderer from the mod's side, and
`tests/test_sky.py` the renderer's motion.
