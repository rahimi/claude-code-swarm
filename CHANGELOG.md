# Changelog

All changes a user of the mod or the `swarm-protocol` skill notices, newest first.

## 0.3.0 (2026-10-19)

### Pane

- Pressing a live agent's name in the live pane shows the last 6 lines of its transcript under the stage, read again every 2 s, with a field that messages the agent (Enter sends, as `/swarm say` does).
- Teammates joining and leaving show in both looks: look A slides a new card in and greys an ended one, look B fades a star in or down, and the header says `+ joined Kite` or `− left t2` for 10 s.
- The log records each teammate's spawn as a `JOIN` line and its end as a `LEFT` line, so a replay shows them too.
- A refused spawn shows in look A's message list as a `REFUSED` line with the reason, from the agent that asked for it.
- Subagents a teammate spawns show under that teammate in the text list while they run; roster.json keeps their `parentId`.
- Look A's bars count tool calls with messages; a slot with a message is brighter.
- Look A keeps the agent cards while they fit with the message list down to 3 rows; after that every agent shows on one line, at rich with a 16-cell bar.
- Claims that do not fit in boxes show one per line, and the last cell says `+N more` when even those do not fit.
- The message list starts right under the taller column (the lead block or the last claim) and takes the rows left.
- The control row and the wake-mode row stay on screen with 20 agent buttons.
- Look B shows the claims as chips under the star map: as many as fit the row, at most 6, then `+N more`.
- Look B counts the lead's wakes in the ring under the sun once its 24 rays are full.
- A double claim shows `⚠ duplicate` in both looks while both claimants hold it, and `BLOCKED` only after a `[BLOCK]`.
- The text list shows the newest 5 other and earlier agents after a `… N more` line, and never runs past the pane's rows.
- A teammate idle for over 6 hours, holding no wait or claim, shows as ended in the pane and the band; the team and the watchdogs still count it live.
- The status line's `done` counts the team's teammates that sent a `[DONE]` since they started and no `[CLAIM]` after it.
- The stand-down toast stays 20 s and gives the lead's wakes per agent: `lead woken 3 (0.8/agent)`.
- The header, the message rows, the text list and the order stamps all use local time.

### Claims and coordination

- The mod answers a teammate's first build or research claim on a free slice with `swarm: <role> <target> is yours.`, once per teammate and slice.
- A slice works as a lock (`merge-lock`): when its holder releases it, the next claimant hears `is yours.`
- A release from a teammate that does not hold the slice frees nothing, and the mod tells it so.
- A report while waiting for a slice ends the wait, and the mod tells the waiter so.
- The `already claimed` answer names up to 3 free slices and says the mod tells the claimant when the slice passes to it.
- A live task-list owner holds its task's target, so a later claim on it hears `already claimed`.
- A `[DONE]` or `[REVIEW]` closes the sender's claims on the slices it names; its other claims stay open.
- A later claim lapses at its sender's next report or its claim of another slice.
- A `[CLAIM]` anywhere in a message counts, unless it is quoted or reports someone else's claim (`they sent [CLAIM] …`). Its log line keeps it as `claim`, so a replay and a reload read it too.
- A first line `[CLAIM] <role> <target> is already taken` (or `held`, `claimed by …`) reports a holder and claims nothing.
- A claim's target is its first token, cut at `,`, `;` or `(`; the words after it never join it. A slice name of several words is claimed in quotes.
- Releases are read from `[RELEASE]` and `[WITHDRAW]` and a few fixed hand-over phrases (`I drop my <target> claim`, `Yielding <target> to …`); other prose that says "release" releases nothing.
- When a code name is already taken, the mod asks the teammate for another.
- Renames are read in lowercase, in quotes and as `I'm kite from now on`; `(now Kite)` and `I am Kite` need a capital, so `(now true)` in prose renames nothing.
- A message sent to a code name counts as sent to the teammate that took it.
- Every message from the mod to a teammate starts with `swarm: `.

### Lead wakes

- The stall watchdog counts an open claim as work left, so it nudges with an empty task list.
- A swarm with no deliverable has no builder to miss: no claim-watchdog wake for one.
- The claim watchdog asks for `[CLAIM] <role> <slice>` when the swarm has no deliverable.
- A message to an address that is neither a teammate nor the lead, such as `lead`, wakes nobody.
- Look A's and look B's LEAD counts count the same wakes, the mod's own included.
- When every deliverable (with none declared, every build and research claim) has a `[DONE]`, no claim but a review claim and no `[BLOCK]` is open and every teammate is idle, the mod wakes the lead once to say so, to start the final review unless it ran, and that `stop_swarm` is its call; it stops nothing.

### Commands and settings

- The lead's tool `stop_swarm` stops every live teammate, or the ones it names, and answers in one line which stopped and which failed.
- `/swarm stop all|<name>` and the pane's `[ stop all ]` button (`x`, asks once) stop teammates the same way.
- `/swarm say <agent> <text>` sends a live agent a message from you.
- Look B's rich sky runs on the python the new `skyPython` setting names; with the setting empty, on `python3` from PATH, else on `uv` with numpy.
- Without that python, look B draws its basic sky and says why under the stage and in `/swarm status`. The still PNG sky and its `skyMaxDrawMs` setting are gone.
- `replay` ends a run at its team's last line before 30 min without one, so a later team reusing the names plays as its own run.
- `replay` shows each agent from its `JOIN` line, else its first log line.

### Protocol skill

- A build or research claimant ends its turn and starts only on the mod's `is yours.`; an `already claimed` answer stops the slice at once. In an 18-agent release test this took slices worked twice from 6 and 8 of 21 in the first two runs to 0 of 21.
- Code swarms build each slice in its own worktree and merge holding `merge-lock`, releasing it only with the integration check green.
- Building less than the claim said needs a `[PROPOSE]` before the handoff; the reviewer checks against the claim.
- A teammate whose slice is done offers a review to a `[DONE]` without one; the lead is never the router.
- `[DONE]` means the whole slice; parts left go in a `[BLOCK]`.
- The lead stops earlier teammates with `stop_swarm` before spawning and uses a fresh placeholder prefix per swarm.
- The brief names output files by placeholder and names the integration branch for code.
- Teammates of one model re-send their hello when their code name is taken.
- A lock waiter's report ends its wait; it claims again to wait.
- Work already done on a taken slice goes to its holder as notes, never as a second file.
- `[RELEASE]` and `[WITHDRAW]` need the tag; other wording may not count.
- Budgets are wall-clock from spawn.
- Final review: once every deliverable is done, the lead spawns 1–3 fresh reviewers with no history (one more per kind of risk, never two with the same lens). They post numbered findings under a `[BLOCK]`; teammates claim each finding like a slice, reproduce it first, and dispute it with evidence to the reviewer; the builder of the slice a finding is about never settles it alone. In a test on two sealed swarm results, three reviewers per result took 3–8 min and about $1.20 each, and found defects that the per-slice reviews and a blind judge had missed.
- The lead never waits or polls inside a turn: the mod holds its wakes while the lead is busy.

### Fixes

- A stopped teammate that a message wakes again keeps its agent id, and the next stop stops it again.
- Look A flags a duplicate code name (`⚠ dup`) whatever its case.
- A teammate spawned after the team formed joins it; a stopped or dormant one no longer joins by receiving a hello.
- A restored agent the agent list no longer reports has ended.
- An ended team gives way to live teammates outside it.
- The claims board clears at the end of a team that reused an ended team's names.
- A new swarm reusing an ended swarm's names gets its own stand-down toast; a swarm stands down once.
- The mod logs its own messages once, as from `swarm`, however late the recipient takes them.
- A `[DONE]` naming a slice shows that slice as `DONE` in the looks until it is claimed again.
- An ended team's messages still queued for a wake, and its idle notices however late, no longer reach the lead; they stay logged.
- A reload keeps the session's wake mode; it no longer takes the mode another session set since.
- Look B's basic sky draws on one flat backdrop, so 256-colour terminals show no bands, and draws each flying word whole or not at all.

## 0.2.0 (2026-10-14)

First public release.

### Pane

- `/swarm` opens a pane with look A (one card per teammate, the claim cards, the lead's wakes, the message list) and look B (the team as a star map around the lead, each message flying as a comet).
- Both looks draw in any 24-bit colour terminal and add pictures where the terminal draws them (`/swarm level auto|basic|rich`).
- Each look A card shows the teammate's state, current action, tool-call count, the file it last touched and a bar of its messages.
- `/swarm replay <log.jsonl>` plays a recorded run back in the pane.
- The status line reads `◇ swarm 3 live · 1 done` while a swarm runs; a toast gives its totals when it ends.

### Claims and coordination

- Every teammate-to-teammate message carries one global order stamp (`#412 · 17:04:12`).
- The mod tells a later claimant who holds the slice, and warns a teammate that writes a file another teammate claimed.
- Every message goes to `.swarm/log.jsonl` and the team to `.swarm/roster.json`.

### Lead wakes

- The lead filter (`/swarm quiet on|off`, default on) keeps protocol messages and idle notices out of the lead's turns.
- Wake modes `mentions` (default), `all`, `digest` and `off` decide which peer messages wake the lead.
- The stall watchdog nudges the claim holder first and wakes the lead only if that does not help.
- The claim watchdog wakes the lead when a deliverable has no builder.
- `[WAIT] <path>` and `[WAIT] until <ISO time>` wake an idle teammate when a file changes or a time comes.

### Protocol skill

- The skill `swarm-protocol` gives the lead the brief, self-chosen code names, `[TYPE] subject` messages, claims, reviewer veto, `[LOCK]`, `[WAIT]` and a fresh agent for the final synthesis.
