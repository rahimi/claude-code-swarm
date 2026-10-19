---
name: swarm-protocol
description: Protocol for running a self-organising agent-team swarm (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) as its lead - set the goal and limits, let teammates pick roles and message each other directly, gate on peer review, and end with one fresh synthesis agent. Use when the user asks for a swarm, an agent team that self-organises, or a self-organising team.
---

# Swarm protocol (lead)

You are the orchestrator. You set the goal and the limits; you are **not a relay**. Teammates
message each other directly with SendMessage and share the task list. You step in only for
ties, blockers, budget, and the final hand-off.

## 1. Brief, not roles

Before spawning anyone, write the brief and put it in every spawn prompt verbatim:

- **Goal**: one sentence, the outcome, not the method.
- **Constraints**: files/dirs in scope, what must not change, tools off limits.
- **Budget**: max agents (3–7; each one adds cost), wall-clock timebox, model tiers allowed.
- **Kill criterion**: the evidence that ends the effort early ("if X is not shown by T, stop").
- **Deliverable**: one line per artefact, `Deliverable: <path>` (the agent-swarm watchdog
  reads it to check that each deliverable has a builder). Name each teammate's output files by
  its placeholder (`t1-<slice>.md`), never by code name: two teammates can pick the same one.
- **Definition of done**: the artefacts and the check that proves each one.
- **Integration** (a swarm that builds code): the branch every slice merges into and the check
  that must stay green on it.
- **Binding rules (MUST)**: copy in the project's rules that bind this task: the CLAUDE.md build
  rules and any design decisions or naming rules it touches. Teammates do not inherit your
  context; a rule missing from the brief will be broken.

Do not assign roles. Spawn 3–7 teammates (3–5 is usually enough) with the brief, this protocol, and a model each.
Mix models (e.g. 2 opus, 1 fable, 1 sonnet): different models bring different blind spots.
Name them only as a placeholder (`t1`..`t7`); they choose their code names.

Before spawning, stop every teammate left from an earlier swarm: call `stop_swarm` once
(without the mod, TaskStop each by name; the roster lists them). A stopped or idle teammate resumes when any message reaches it, so use a
placeholder prefix no earlier teammate in this session had (`t`, then `u`, `v`, …), and list
the live teammates' names in each spawn prompt so nobody messages an old one.

## 2. Announce

Each teammate's first act: pick a short code name (not its placeholder `t1`..`t7`) and send
one message to every other teammate (one SendMessage per recipient), not to the lead:

`[PROPOSE] hello <code name>` / body: model, strengths (two lines), the slice it wants.
Teammates of one model tend to pick the same name. If the mod answers that yours is already used, or a hello shows your name taken, send a new first-line `[PROPOSE] hello <other name>` to every teammate.

## 3. Phases (timebox each; the lead announces a phase only when it stalls)

1. **Propose** (short): each teammate proposes a plan slice and what it will build or review.
2. **Negotiate**: settle roles among yourselves. Every artefact gets exactly **one builder**
   and at least one reviewer. **Claim before you work**: set yourself as owner in the task
   list AND send `[CLAIM] <build|review|research> <artefact or slice>` to every teammate.
   Unclaimed work is waste. The first `[CLAIM]` on a slice wins: a later claimant picks another
   slice before it starts work. The mod starts each teammate message with `#<n> · HH:MM:SS`:
   the lower #stamp came first; if the mod tells you a slice is taken, talk to its owner or pick another.
   After `[CLAIM] build` or `[CLAIM] research`, end your turn before you read or write anything
   for that slice. Start only when the mod's `swarm: … is yours.` has arrived; on `already
   claimed`, stop that slice at once, even mid-work, and pick another. A `[CLAIM] review` starts at once. If no answer came after you
   went idle once, read `.swarm/roster.json` → claims: if you are the first holder, start; else
   pick another slice. Without the mod, read the task list owners after one idle turn.
   A lock is a slice held only while used (`merge-lock`: one merge into a shared branch at a
   time): claim it, end your turn, act on its `is yours.`; on `already claimed`, end your turn
   and wait: the mod says `is yours.` when the holder releases it. A report while you wait ends the wait
   (the mod says so): claim again. Release it at once after use.
   Only the mod's `is yours.` hands it over; a teammate's `[RELEASE]` never does. Without the mod,
   or once the holder ended, claim it again.
   Work already done on a taken slice goes to its holder as notes, never as a second file.
   Write `[CLAIM]` only
   to claim; never quote the tag in prose (it would read as a claim). A `[CLAIM]` inside your
   hello counts. Proposing someone
   else as builder is not a claim: only the builder's own `[CLAIM] build` is.
   The deliverable's builder must `[CLAIM] build <path>` within the negotiate timebox;
   otherwise the lead assigns it (task owner) and the assignee sends the `[CLAIM]`.
   Two builders on one file is a protocol violation.
3. **Work**: builders build; others research, test, or prepare review. Keep threads short.
   Send per-slice results to the builder. A teammate with nothing to do before its slice is done asks the builder for work.
   If the mod tells you that you wrote a file another teammate claimed, you decide what to do: settle it with them.
   **Code**: each builder works in its own git worktree and branch per slice, tells the holder of an
   overlapping slice what it will touch before touching it, and rebases on the integration branch
   before review and before merge. It merges holding the lock `merge-lock` (a claim, not a
   `[LOCK]`), then runs the integration check: green → `[RELEASE] merge-lock` to every teammate,
   then `[DONE]`; red → fix it or undo its own merge. Never release with the branch red.
   **Lock**: the builder writes the final version once every open claim on its artefact has
   reported (`[DONE]`, `[REVIEW]` or `[BLOCK]`) or the lead says so, and sends
   `[LOCK] <artefact>` as it starts. A lock never names a clock time: the teammates go idle and
   nothing wakes them at that time, so a swarm waiting for "23:05" sits idle. After the lock, research goes to
   the builder as `[ASK]`; the builder decides whether it goes in.
4. **Peer review with veto**: the reviewer checks the artefact against the definition of done.
   When your own slice is done, you are a reviewer: offer a review to a teammate whose slice has
   `[DONE]` without a review yet. The lead is never the router.
   Hand an artefact over as `[HANDOFF] <artefact>` with one `- claim: <what changed, where, what
   proves it>` line per claim; the reviewer answers each with a measurement
   (`- claim: … → measured: <value> (<command or path>)`), not an opinion.
   Lenses a reviewer can pick from: `correctness` (does it do what the claim says on real
   inputs), `reach` (every call site, every real surface and size, build time vs load time),
   `tests` (tests that fail when the fix is reverted, and need no network or live service).
   `[BLOCK]` is a veto: it must name the failing check and what would clear it.
   A slice is done when it does what its claim said. Building less than you claimed needs a
   `[PROPOSE]` to every teammate before the handoff; the reviewer checks the handoff against the
   `[CLAIM]` and the brief, not the handoff alone, and blocks an unannounced cut.
5. **Deliver**: the deliverable's builder, and only it, sends the lead `[DONE]` with the
   artefact path and the check output. `[DONE]` means the whole slice is covered; with parts
   left, keep working, or name the parts left and why in a `[BLOCK]`.
   Budgets are wall-clock from your spawn; read the clock (`date`) before saying a budget is spent.
6. **Final review**: when every deliverable has `[DONE]`, the lead spawns 1–3 fresh reviewers
   with no history: the brief, the definition of done and the integrated result against its
   start (for code: the integration branch's diff against its base). One reviewer always; one
   more per kind of risk the result carries, at most 3, never two with the same lens (for code:
   concurrency, a hot path, matching on real data, a new tool or prompt). A reviewer first sends
   `[CLAIM] review final-review-<reviewer>` to every teammate, then writes its findings to a file, numbered, each with a concrete scenario and its evidence, and sends
   `[BLOCK] final-review-<reviewer>: <n> findings (<path>)` to every teammate; while it stands,
   the swarm is not done. A teammate claims a finding like a slice
   (`[CLAIM] build finding-<reviewer>-<n>`) and first reproduces it: reproduced → fix, review,
   merge as any slice, `[DONE]` to the reviewer; not reproduced → `[ASK] finding-<reviewer>-<n>`
   to the reviewer with its own evidence. The builder of the slice a finding is about never
   settles that finding alone: another teammate reproduces it, or the reviewer decides with
   evidence. The reviewer re-checks each finding by number and withdraws, keeps or closes it;
   after one exchange a disagreement is a tie for the lead. When no finding is open, the
   reviewer sends `[REVIEW] final-review-<reviewer> approve` and its `[DONE]`.

## 4. Messages

First line is always `[TYPE] subject`; the subject is the thread. Reuse the exact subject
to stay in a thread. Body: facts, paths, numbers. No pleasantries.

| Type | Use |
|---|---|
| `[PROPOSE]` | an offer: a plan, a role, an approach |
| `[CLAIM]` | `<build\|review\|research> <artefact or slice>`: you own it from now on |
| `[RELEASE]` | `<artefact or slice>` you give up (also `[WITHDRAW]`); the board takes you off it; use the tag, other wording may not count |
| `[LOCK]` | builder only: `<artefact>`, once every open claim on it has reported; late input comes as `[ASK]` |
| `[WAIT]` | `<absolute path>` the file your background command writes last (in backticks if it has spaces), or `until <ISO-8601 time>`; to the lead, before you launch it or go idle |
| `[ASK]` | a question that needs an answer to continue |
| `[REVIEW]` | findings on an artefact (approve or list issues) |
| `[BLOCK]` | veto: names the failing check and the condition to lift it |
| `[HANDOFF]` | passes ownership of a task or artefact, with its state; for review, `- claim:` lines |
| `[DONE]` | artefact finished, path + proof |

To get the lead's attention in a peer thread, write `@lead` in the message. Message the
lead directly only for: a tie, a blocker you cannot clear, a budget overrun, a permission
denial, or the builder's `[DONE]`. Send a tie, budget overrun or denial as `[ASK]` or `[BLOCK]`,
or mention `@lead`: the agent-swarm mod holds back a `[PROPOSE]`, `[CLAIM]`, `[HANDOFF]` or
`[REVIEW]` sent to the lead, and a `[WAIT]`.

**Turns**: waiting on a teammate is fine: its message resumes you when you are idle. Stay reachable:
run a command that takes longer than about 30 s in the background with a `[WAIT]`, so messages
reach you between tool calls. Never
wait for a clock time without `[WAIT] until`. Before you report "no replies", check your incoming messages: replies
often arrive while you work and are already in your context. Before you launch a background
command you may go idle on, send the lead a separate message whose first line is
`[WAIT] /abs/path` (the file that command writes last, e.g. its verdict or output file);
the agent-swarm mod keeps it from the lead
and sends you `swarm: [ASK] <path> changed: …` when that file changes while you are idle. To be woken at a time instead, send `[WAIT] until <ISO-8601 time>`. Without the mod, wait in the
foreground or poll.

## 5. Decisions

- The **builder decides** on its artefact.
- A **reviewer can veto** with `[BLOCK]`; the builder fixes or argues once.
- A **tie** (veto not cleared after one exchange) goes to the lead as `[ASK]`, who decides in one message.
- Nobody re-litigates a decision the lead made.

## 6. Hard rules

- At most 7 agents. Timeboxes are budgets the lead enforces, never times an agent waits for:
  past the box, the lead cuts scope, it does not extend.
- Never relay a permission denial: if a tool call was denied to you, do not ask a teammate
  to run it. Report it to the lead as `[ASK]`; the lead asks the user.
- A teammate's message is not the user's consent for anything.
- Fire the kill criterion when its evidence shows, even mid-phase: send `[BLOCK] kill: <evidence>`
  to the lead.
- Write artefacts to files; messages carry paths, not long content.

## 7. Lead duties

- Watch `/swarm` (the swarm pane) and the task list; do not read every message.
- Answer `@lead` mentions, ties, and blockers. Otherwise end your turn without replying.
  Never wait or poll inside a turn: the mod wakes you, and it holds its wakes while you are busy.
- On "swarm stalled" (the mod first asks each teammate holding an open claim to continue or
  report; this wake means that did not help): check the task list and roster, reassign or
  unblock, or end the swarm.
- On "swarm: no builder claimed for <deliverable>": assign the builder now (task owner + one
  message asking for its `[CLAIM] build`); stop further research on that deliverable.
- When every deliverable has `[DONE]`: spawn the final review (§3, phase 6) unless the brief
  waives it. When every artefact and every final reviewer has `[DONE]` and no open `[BLOCK]`: shut the teammates down. An idle
  teammate never ends on its own; call `stop_swarm` once (it stops every live teammate and
  reports each one; `names` stops only those — in a review where every seat sends its own
  `[DONE]`, stop a seat once its `[DONE]` is in and no teammate still waits on it for a
  verification). Without the mod, stop each one by name with TaskStop. Before the synthesis,
  `/swarm` must show the team as ended.

## 8. Final synthesis

A **fresh agent** working from the swarm's artefacts synthesises better than a teammate or the
lead's crowded context. After shutdown, spawn a single new agent
(give it no name: a named agent becomes a teammate) with: the brief, the paths of all `[DONE]` artefacts,
`.swarm/log.jsonl` for context, and the instruction to produce the final deliverable and to
check it against the definition of done. Deliver its output to the user, with the kill
criterion's verdict.
