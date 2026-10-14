

https://github.com/user-attachments/assets/05a3fee8-e468-4fd7-bd37-71c663888574

# swarm

A Claude Code mod plus a skill for leading a self-organising **agent team**: teammates message each
other directly with SendMessage, and the lead sets the goal and is woken only when it is needed.

**Status: experimental.** Needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and Claude Code
≥ 2.1.287; built and tested against **2.1.296**. Mod events and methods change between releases.

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
  duplicate `[CLAIM]` is settled by the lower stamp, and tells a later claimant who holds the slice;
- nudges the claim holder when the swarm goes quiet, and wakes you only if that does not help;
- tells you when a deliverable has no builder;
- wakes a teammate when the file its background command writes changes (`[WAIT] <path>`) or at a
  time (`[WAIT] until <ISO time>`), so nobody polls;
- writes every message to `.swarm/log.jsonl` and the team to `.swarm/roster.json`, which you can read.

**When to use it.** A team of 3–7 teammates under `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` working
on research, review, exploration or a creative build. For shipping code, one builder with
independent reviewers did better (see [What we measured](#what-we-measured)).

**Measured benefit.** In a 7-agent run the lead was woken once while 61 messages to it were held.
Claims are ordered by stamps, stalls are nudged before the lead hears of them, and teammates use
`[WAIT]` instead of polling.

**Install and check** (shell; then start a new session):

```bash
claude plugin install agent-swarm --marketplace rahimi/claude-code-swarm
claude plugin list                      # agent-swarm is listed and enabled
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

In the session, `/swarm status` answers with one line (`swarm: yes/no`, `quiet: on`, the log path).
Without installing: `git clone https://github.com/rahimi/claude-code-swarm` and start
`claude --plugin-dir ./claude-code-swarm`.

**The instructions for the lead** are the skill `swarm-protocol` (`agent-swarm:swarm-protocol`,
[skills/swarm-protocol/SKILL.md](skills/swarm-protocol/SKILL.md)): the brief, self-chosen code
names, `[TYPE] subject` messages, claims, reviewer veto, `[LOCK]`, `[WAIT]` and a fresh agent for
the final synthesis. Load it before you spawn the team, e.g.
`Use the swarm-protocol skill. Goal: … Budget: 4 agents, 30 min. Kill criterion: … Done when: …`.

## For humans

https://github.com/user-attachments/assets/6c096b84-152b-4982-863a-38c02b2a3531

### The pane

`/swarm` opens a pane with two looks. **Look A** (the default, key `1`) is the working view: one
card per teammate with its state, time in it, current action and tool-call count, the file it last
touched, and a bar of its messages over time; the claim cards; the lead's wakes, delivered and held;
the message list. **Look B** (key `2`) shows the team as a star map around the lead, each message
flying as a comet, for watching and demos. Both draw in any 24-bit colour terminal and add pictures
where the terminal draws them (`/swarm level auto|basic|rich`).

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

`/swarm replay .swarm/log.jsonl` plays a finished run back in the pane. While a swarm runs, the
status line reads `◇ swarm 3 live · 1 done`; when it ends, a toast gives its totals
(`swarm stood down: 4 agents · 52 messages · 12m · lead woken 3, held 18`).

### What we measured

One project, a handful of runs: treat these as data points.

- **Benchmark.** On code, a builder with independent reviewers beat the swarm: peer reviewers inside
  the swarm shared the builders' blind spots. The swarm was the fastest and the cheapest, and the
  best at research. A 17-minute swarm review produced 21 findings; of 10 checked, 6 held, 3 held
  with the impact overstated, 1 was trivial, 0 were wrong.
- **Film trial.** A four-agent swarm made the owner's favourite film. A single agent tied it at
  about 1/3 of the cost.

### Install

One session: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --plugin-dir <path to this directory>`.

Permanently (Claude Code 2.1.287+), in a session:

```
/plugin install agent-swarm --marketplace rahimi/claude-code-swarm
```

Look B's rich sky uses `python3` with numpy for smooth motion; without them it falls back to a still PNG sky (`/swarm status` says which). Nothing else needs Python.

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
other, from 30 s before their first peer message); without `--from`/`--to` it plays the
most recent run; its reply lists the runs with their `--from`/`--to`, `▶` on the one playing. A replay sends nothing.
A finished replay holds its last frame for 3 s, marked `replay finished`, then the pane shows the live view.
When a live team spawns a teammate or sends a peer message during a replay, the header says `live swarm running` and a `[ live ]` button (`0`) stops the replay and shows it.
Start a swarm by asking the lead to use the `swarm-protocol` skill, e.g.
`Use the swarm-protocol skill. Goal: … Budget: 4 agents, 30 min. Kill criterion: … Done when: …`.


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
250 ms after the lead's turn completes. Per the 2.1.296 types, `$.prompt.submit` from a plugin
"runs once idle" and resolves when its turn starts, so the mod never awaits it inside a hook
(a `session.receive` hook awaiting its own submit hangs) and sends one wake at a time.


### Reference

| Part | What |
|---|---|
| Message log | Observes every message agents send each other (`session.send`, `session.receive`, and `tool.call` on `SendMessage` as a fallback) and appends `{ts, from, to, summary, length, type, via}` to `<cwd>/.swarm/log.jsonl`. A delivery whose text a recorded send carried (one of the last 200, from the same sender or to the same recipient) is that send's echo and is not logged again, however late the receiver takes it. The mod's own sends (stall nudges, wait asks) never reach its own hooks; it logs each one itself as from `swarm`, and they are never read as claims. Every hook calls `next` except the `[WAIT]` refusal below, and each has a fail-open `.catch`. |
| Order stamps | Each message a teammate sends another teammate reaches it with `#<n> · HH:MM:SS` (UTC) on its own first line: `n` counts the session's teammate-to-teammate messages as the mod logs them (kept in roster.json and the log's `stamp` field across reloads), so every recipient sees one order; the lower stamp came first. Sends to the lead, broadcasts (`*`, which reach the lead too) and the mod's own carry none. |
| Roster | `agent.spawn` (name, model, teammate flag) + `$.agent.list()` every 4 s (status) → `<cwd>/.swarm/roster.json`, readable by any agent. A teammate's first-line `[PROPOSE] hello <Name>` sets its `codeName` (casing as written); roster.json, the pane and the band then show it as `Atlas (t1)`. A later message it sends renames it: another hello, or `I (t3) rename to kite`, `renamed Kite`, `(renamed kite)`, `(now Kite)`, `call me Kite`, `now called Kite`, `I am now Kite`, `I am Kite` (the last two need a capital). A delivery received later never reverts a name. Two live agents with the same code name (any case) both show `⚠ dup`. A teammate whose hello keeps its placeholder (`hello t1`) shows as `t1 (no code name)`. |
| Workflow agents | Agents a Workflow script starts (`agent.spawn`'s `workflow.runId`, type `workflow-subagent`) are never in `$.agent.list()`. Each is marked completed when its `turn.complete` arrives; on reload one left pending for over 10 min is completed. The pane shows one line per run, `✓ workflow dev-team · 16 agents` (dimmed under other agents) or `● … · 3 running · 5 pending`; the name comes from the Workflow tool call's result (`workflowName`, `runId`). Any other agent that `$.agent.list()` stops reporting is marked completed. |
| History | On load or reload the mod reads roster.json and the last 500 lines of log.jsonl. Lines and agents written in this session (both files carry `session-<first 8 of the session id>`) count as before; those from a previous session or team show dimmed under `── earlier ──` and as `(N earlier)` in the header. |
| `/swarm` pane | Look A by default: one card per agent of the current team with its full name, model, sent/received counts, state (running, idle, waiting on a `[WAIT]`, stalled) and time in it, the file it last edited, wrote or read (`✎ hooks/core.ts`, `◦ README.md`), and a bar of its messages per time slot coloured by its state, on one time axis for all cards; the claim cards; the lead's wakes, delivered and held; the message list newest first, names in full. A message moves through the cells for 0.7 s as it lands; nothing animates in between. The pane opens with the keyboard (`/swarm` from an empty prompt; Escape hands it back and closes the pane). Buttons, each also a key while the pane has the keyboard: an agent's name filters to its threads; keys `1` (look A) and `2` (look B, the team as a star map around the lead, wakes counted beside it, for watching and demos) and the `[ list ]` button (`l`, the text list below) switch the view; `a` `m` `d` `o` set the wake mode. A replay's row has `[ live ]` (`0`) while a live team is active, the agents, then `[ nudge ]` (`n`), `[ pause ]` (`p`) and `[ stop ]` (`s`); `1` and `2` switch its look. The current team is the latest set of teammates that messaged each other; before one exists the cards show the live teammates. |
| Pane level | `basic` draws text cells only; look B's basic sky (for terminals without pictures, such as Apple Terminal and tmux) paints the star map in half-block cells with 24-bit colour and braille edges: each message flies as a comet with its type riding quietly behind it (a burst as `claim ×5`, at most 6 words at once), its edge lighting up behind it, a held comet splashing at the membrane and a delivered one flaring its receiver, frames only while something moves. `rich` adds pictures (the bars, the wake strip, the star map), each drawn again only when what it shows changed. The bars and the wake strip are raw pixels, at most once a second and 100,000 characters of base64 (about 75 KB) each. The star map is a PNG drawn at 10 × 20 pixels a cell (the types give a mod no cell size), at most 1,000,000 pixels and 300,000 characters of base64, at most once every 2 s; one that would pass the cap is drawn again smaller, never skipped. A message lights its edge on the star map with a comet at the receiver in the next sky, a step dimmer in each of the next two, gone after 6 s; every message of a burst lights its own edge. Where `python3` with numpy runs, look B rich hands its sky to `hooks/sky.py`, a renderer process started the first time look B rich is shown and paused while it is not (another look, the list, a replay restarting); it leaves after 2 min without a scene and starts again when wanted: the mod writes the scene (agents, edges with their weights, lit edges, wake counts and comets, in the picture's pixels) to a temp folder (`$TMPDIR/swarm-<session>`) when it changes, and draws no picture itself; the renderer paints the whole star map, the backdrop once per size, at up to 30 frames a second while a comet flies or a lit edge fades (about 10 ms a frame at 860 × 620), and writes each frame to a file, and the pane shows each frame by naming that file, so the terminal reads the pixels itself; idle, no frame is drawn. The renderer removes its files when it ends. When python3 or numpy is missing, the renderer crashes twice, or the terminal says it cannot read files or draw pictures, the pane falls back for the session to the PNG sky below; `/swarm status` says which. The sky stands on its own dark colour, so a terminal that fits it inside its box shows no grey bars. A comet's edge lights up behind it as it flies, a pair's first edge drawn only as far as its first comet got; a comet the lead filter holds stops at the membrane with a ripple, one that reaches the lead flares the sun. When a comet lands, its type shows under the receiver's name for 1.5 s, a burst bundled (`claim ×3 · handoff`). Without the renderer, look B rich shows the still PNG sky, drawn again only when an agent, its state or an edge changes and at most once every 10 s, its lit edges drawn without fade, and the arrivals; nothing flies. When one PNG sky takes the mod longer than the `skyMaxDrawMs` setting (default 50 ms; in `/config`) to draw, look B turns basic for the session (`/swarm status` says so). A terminal whose cells are not 1:2 fits it with thin bars. On recorded runs played live that came to 0.04–0.34 MB a minute for look A and 0.29–2.32 MB for look B; look B's ceiling is 9 MB a minute. With `/swarm level auto` (the default) the pane draws one 1×1 picture and goes rich when the terminal shows it (a blit taken), basic when the terminal says it draws no placeholder images; any other refusal (no image id free) keeps it basic and is asked again, at most three times. |
| Text list | Roster with live status, model as family and version (`opus 5.5`; `–` when `agent.spawn` never reported one), sent/received counts and `waits N · 40s ago` (an agent without a name shows its spawn description); a teammate idle past the stall minutes while holding an open claim shows `! … stalled`. Active teammates come first; agents outside the current team, completed, failed or killed, or pending for over 10 min, show dimmed under `── other agents ──`. The last N messages newest first (`from → to: first line`), a previous session's below them under `── earlier ──`, time since the last message, wake-mode buttons (`a` `m` `d` `o`). Lines are cut to the pane's `bodyColumns`. |
| Band | One line above the prompt once a swarm is active: `swarm: 4 agents · 12 msgs · last 8s · wake: mentions · wakes 3 · held 9 · Atlas (t1), Sage (t2)`; the agent count is the current team's agents that have not ended, the names are the current team's only. |
| Status line | While the current team is a swarm, the mod's status line under the prompt reads `◇ swarm 3 live · 1 done` (`· 1 failed` when any failed), counted over the team's teammates and pinned again only when it changes (checked every 2 s); it clears when the team ends. |
| Stand-down toast | Once the last teammate of a swarm has ended, one toast with its totals: `swarm stood down: 4 agents · 52 messages · 12m · lead woken 3, held 18` (messages to or from its teammates since its start; the lead's wakes and held deliveries during it). Once per team, and only for a team that was a swarm. |
| Ended team | A teammate the agent list reports as `completed`, `failed` or `killed` (a stop), or no longer lists, has ended. Once every teammate of the current team has, the live pane shows it as ended: `ENDED · f1–f4 · ran 26m` in the header (look B: `■ ended · ran 26m`), every agent as `ENDED` on its card and in the count (`4 · 4 ended`), the clock and the idle counters held at the team's last activity, no claim cards; the claims board is cleared once per team, even while other teammates of the lead stay idle. |
| File activity | A teammate's Edit, Write, MultiEdit, NotebookEdit and Read calls reach the mod's `tool.call` hook with the teammate's `agentId` (in-process teammates). When the file a teammate last touched changes, its card shows it and the mod appends one `{type: "FILE", from, summary: "✎ hooks/core.ts"}` line to the log; repeated calls on the same file write nothing, and a read of a file the teammate read in the last 5 min shows on the card only. Teams are worked out from messages alone, so file lines never push a team out of the pane's memory. The lead's own calls are not logged. |
| Current action | Each tool call a teammate makes shows on its look A card in plain words (`Reading README.md`, `Editing hooks/core.ts`, `Running npm test`, `Searching 'claimOf'`, `Messaging t2`, else `Using <tool>`), cut to the card, kept after the call ends and dim unless the teammate is running, with its call count in the card header (`12×`); it replaces the file on that line. The mod logs it as a `type: "ACT"` line with the count so far, at most one per teammate per 2 s (a call in between shows when that time is up, the latest winning), so a replay shows actions too. |
| Swarm | The stall watchdog, the claim watchdog and the lead filter act only once the current team is a swarm: two of its teammates have messaged each other and one of them has not ended. Named agents that only report to the lead (a builder, a checker) are no swarm. `/swarm status` shows `swarm: yes/no`. |
| Lead filter | `quiet on` (default), once the team is a swarm: a delivery to the lead from a live teammate of the current team is logged, counted and run through every watchdog, then taken with `session.receive` → `{ consumed }` when it is an idle notice whose reason is `available` or absent, or a `[PROPOSE]`, `[CLAIM]`, `[HANDOFF]` or `[REVIEW]` that neither mentions `@lead` nor has a line starting `[ASK]` or `[BLOCK]`. Idle notices from a swarm's teammate that ended in the last minute (a team the lead just stopped) are taken the same way. So is an idle notice from any teammate, swarm or not, whose message reached the lead in the last 60 s: it repeats that report. Everything else reaches the lead: `[ASK]`, `[BLOCK]`, `[DONE]`, idle notices with a failure reason, untyped text, other sessions' messages and the mod's own wakes. The band shows `wakes N · held M`. |
| Wake | Wakes the lead with `$.prompt.submit` (framed as a message from the plugin, not the user). Modes below. |
| Claims | `[CLAIM] <role> <artefact or slice>` messages (the first word must be `build`, `review` or `research`; any other is no claim) and task-list owners → `claims` in roster.json and a CLAIMS section in the pane: one line per deliverable or slice, `#1 · build Atlas (t1) · review Sage (t2) ✓approve` (`build unclaimed`, `⚠ duplicate`; a first-line `[REVIEW] #n … approve` sets `✓approve`, a `[BLOCK] #n` sets `✗block`, on the build when the builder sent it), then one `other · Atlas (t1): final gate` line with each teammate's task-list claims whose subject starts with no role word. Deliverables come from `Deliverable: <path>` lines in teammate spawn prompts or `/swarm deliverable <path>`; a claim names one by path, file name, trailing segment or `#<n>` (`[CLAIM] build #155 (…)` names `repo#155`). A `[CLAIM]` later in a message (inside a hello) counts. A claim is judged on its target token (the first word after the role word, or the inside of a quoted or bracketed start): when that is empty, holds a space or a `"`, or says `please`, the claim is a sentence fragment and no claim. A reload restores this session's claims, deliverables and fired watchdog alerts from roster.json and the log. Once every teammate has ended (completed, failed, killed, or gone from `$.agent.list()`), the mod clears that team's message claims, verdicts, deliverables and fired alerts (`claimsSince` in roster.json; a reload replays only claims logged since); a task-list owner claims only while it is a live teammate. |
| Claim conflicts | Inform, never enforce. A `[CLAIM] build` or `research` on a target another teammate already holds (the same `#<n>`, a path that ends the other at a folder boundary, or a file name and a path ending in it, so `design.md` and `docs/design.md` match but `docs/notes.md` and `src/notes.md` do not; other words only when the whole targets are equal) is recorded under the first claim, shown with `⚠ duplicate` while both still hold it (a holder that ended or sent `[DONE]` or `[REVIEW]` after its claim no longer does), and its sender gets one `[ASK] <target> is already claimed by <name> (<id>, since <time>, #<stamp>). Talk to them, split it, or pick another slice.` from the mod (kept across a reload in roster.json `askedTaken`); the holder is the lowest stamp. A teammate's Edit, Write, MultiEdit or NotebookEdit on a file other teammates hold a build claim on goes through; afterwards the writer gets `[ASK] you wrote <path>, claimed by <name> (<id>). Settle it with them.` and the first holder a copy, at most once per writer and file every 2 min. |
| Claim TTL | A claim whose holder has sent nothing for 10 min shows as `stale` in CLAIMS (`#7 · build t1 stale`). It stays open: the stall nudge covers it. |
| Claim watchdog | Once the team is a swarm, wakes the lead once per condition, coalesced, never mid-turn: a teammate sent `[DONE]`/`[HANDOFF]` while no `[CLAIM] build` names the deliverable, or 2+ teammates have each worked without any claim for N minutes since their own spawn (else first message; default 3, `/swarm claim <min>`, 0 = off) → `swarm: no builder claimed for <deliverable>`. |
| Idle notices | Agent Teams sends the lead an `idle_notification` on every teammate stop (native, the mod cannot stop it). The mod counts them per agent (`waits N · <age> ago` in the pane, `idleNotices` in roster.json, a reason other than `available` shown), logs them as `type: "IDLE"`, and keeps them out of message counts and wakes. With the lead filter on, one whose reason is `available` or absent is kept from the lead; one with another reason reaches it. |
| Wait wake | A teammate about to launch a background command it may go idle on sends `[WAIT] <absolute path>` (the file that command writes last; the path ends at the first space, a path with spaces goes in backticks). Its latest wait is kept in roster.json across reloads. Every 10 s, for each idle teammate (an idle notice and no message since) with a wait, the mod stats the file; when its mtime is newer than the start of the turn that sent the wait (the teammate's last idle notice, else its spawn) and than the last wake, it sends that teammate `[ASK] <path> changed: <first 200 characters, one line>` with `$.session.send({ to: { agentId } })`. `[WAIT] until <ISO-8601 time>` is the second form: the idle teammate gets `[ASK] <time> reached: the time your [WAIT] named` once that time has come. A `[WAIT]` addressed to the lead is not delivered: the `session.send` hook answers `{ isDelivered: false, reason }`, and the teammate reads that the wait is registered. |
| Stall watchdog | Every 2 s, once the team is a swarm: no message and no agent running/pending/waiting for M minutes (default 5) while tasks remain. First it sends each live teammate holding an open claim (a `[CLAIM]` it sent after its latest `[DONE]`/`[REVIEW]`/`[BLOCK]`) one `[ASK] swarm quiet <M> min: you hold build src/parser.ts; reported: Sage (t2) REVIEW. Continue, or send [DONE]/[BLOCK].` Each open claim is nudged once, a teammate at most once per 10 min (a stall that finds a claim holder waiting out its cooldown waits with it, and nudges then), counted only when delivered; a report from its holder closes it, a re-sent `[CLAIM]` is a new one. When the swarm is quiet again M minutes after a nudge (chatter in between or not), or no un-nudged open claim is left, it wakes the lead with `swarm stalled`, once per quiet period. |
| Skill `swarm-protocol` | The protocol the lead follows: brief (goal / constraints / budget / kill criterion / done), self-chosen code names, phases, `[TYPE] subject` messages, builder decides / reviewer vetoes / tie to lead, no waiting for a clock time (`[LOCK]` once every open claim has reported, `[WAIT]` before idling on a background command), 3–7 agents, fresh-agent synthesis. |

Claude Code's own `TeammateIdle` and `TaskCompleted` hooks keep a teammate working, or a task
open, at the moment it would stop; use them for hard gates such as "tests pass before you
stop". The mod covers what they cannot: waking an idle teammate later, and the lead's load.

### Known limitations

- Split-pane (tmux/iTerm2) teammates run in their own processes; their messages do not reach the
  mod. Use the default in-process mode.
- Teammates can duplicate work before they claim it; the mod reports it, it cannot prevent it.
- Some fields it reads (the task list, idle reasons, agent names) are undocumented; where one is
  missing the pane shows `–` or `open tasks: unknown`.
- Built against Claude Code 2.1.296; mod events and methods change between releases.

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
`hooks/register.ts` wires them to events; `hooks/looks.ts`, `hooks/grid.ts`, `hooks/pixels.ts` and
`hooks/png.ts` are the shared drawing helpers (palettes, the cell grid, the pixel canvas, a PNG
encoder); `hooks/pane-draw.ts` cuts a frame into Rasters and Images; `hooks/sidecar.ts` runs
`hooks/sky.py`, the look B sky renderer. `tests/core.test.ts` pins the rules,
`tests/register.test.ts` drives the hooks through the test kit with a mock clock,
`tests/replay.test.ts` covers the looks and the replay, `tests/pane.test.ts` the pane,
`tests/sky.test.ts` the renderer from the mod's side, `tests/png.test.ts` the encoder, and
`tests/test_sky.py` the renderer's motion.
