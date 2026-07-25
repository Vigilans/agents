# agent-copilot scenario tests

Replays a fixed hook input through the pipeline and asserts the decision.
Every scenario calls the model, so results vary with the model in use — the
assertions are written to survive that.

## What is asserted, and what is not

**Asserted: the outcome.** The hook stdout Claude Code would act on — whether
the agent was held up, and what the reason names.

**Reported, not asserted: which stage produced it.** A scenario that clears at
Stage 1 today may flag and clear at Stage 2 under a different model, with the
same verdict at higher cost. That is a cost regression worth seeing, not a test
failure. The runner prints the stage breakdown per scenario, plus a summary of
how many reached Stage 2.

`deny` vs `ask` is likewise a conservatism dial the model may move, and both
stop the agent. Prefer `intervenes` unless a scenario genuinely depends on the
exact shape.

## Two kinds of fixtures

**Tracked** — one `<check>-clear` / `<check>-intervene` pair per check in
[hooks/checks/](../hooks/checks). Synthetic: invented project, invented
conversation, no private content. They double as worked examples of the format.

**Local** — full copies of real sessions, for reproducing and debugging a
specific incident. Never committed: `.gitignore` ignores `tests/fixtures/*` and
opts the tracked ones back in by name.

## Layout

```
tests/
├── run.mjs                     # runner: node run.mjs [scenario ...]
└── fixtures/
    └── <scenario>/             # stands in for ~/.claude
        ├── hook-input.json     # hook payload
        ├── expect.json         # assertions
        ├── transcript.jsonl    # conversation leading up to the hook
        ├── CLAUDE.md           # optional: user-level instructions
        ├── settings.json       # optional: user-level permission rules
        └── project-cwd/
            └── CLAUDE.md       # optional: project-level instructions
```

## Writing a scenario

- `hook-input.json`: the payload Claude Code would send. Set `cwd` to
  `./project-cwd`; the runner resolves it against the fixture dir.
- `transcript.jsonl`: the tail entries needed to reconstruct the situation.
  Omit the header — `loadTranscript` synthesizes the first user message.

  Set each entry's `cwd` to `"."`. Claude Code stamps entries with the cwd they
  were recorded in, and **that** cwd is where CLAUDE.md is read from. The runner
  rewrites `"."` to the scenario's project dir in a temp copy, so the committed
  fixture stays machine-independent. An entry pointing at a path that does not
  exist silently yields no CLAUDE.md, and checks that recall it never fire.

- Some checks need specific transcript furniture to engage at all:
  - `skill-suggest` reads the skill listing from a
    `{"type":"attachment","attachment":{"type":"skill_listing","content":"..."}}`
    entry.
  - `auto-mode` only registers on `Stop` when auto mode is already on, which it
    detects from a `hook_additional_context` attachment containing
    `<copilot-auto-mode-on>`.

- `settings.json`: permission rules, as they would appear under `~/.claude`.
  Pinning them here is what makes a `permission-*` scenario mean anything —
  write rules against a command name that could not plausibly be allowed on a
  real machine, or the scenario passes whether or not the snapshot was honored.

## Permission scenarios

A `PreToolUse` call already covered by the permission rules settles before the
transcript is read: copilot answers `defer` and Claude Code decides. These
scenarios need no `transcript.jsonl` and spend no tokens — the runner reports
them as `short-circuit (no API)`.

They assert `permissionDecision: "defer"`. Only the positive direction is worth
a scenario; a call that is *not* pre-approved simply goes on to the full
pipeline, which is the ordinary path the other scenarios already cover.

- `expect.json`:

```json
{
  "outcome": {
    "intervenes": true,
    "mustContain": ["publish"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `intervenes` | `true`: the call/turn was held up by any means (`deny`, `ask`, `decision: block`, `continue: false`). `false`: it was let through — staying silent and explicitly allowing both count. |
| `decision` / `permissionDecision` | Pin the exact shape. Use sparingly. |
| `mustContain` / `mustNotContain` | Substrings of the serialized output. Prefer entities the reason must name (a file, a command) over wording, which drifts between models. |

Omit `outcome` to run a scenario for its trace without asserting.

## Running

```bash
node tests/run.mjs            # all scenarios
node tests/run.mjs foo bar    # specific scenarios
```

Requires `AGENT_COPILOT_MODEL` (or `ANTHROPIC_SMALL_FAST_MODEL`).

The runner points `AGENT_COPILOT_CLAUDE_USER_ROOT` at each scenario's
directory, so its `CLAUDE.md` and `settings.json` stand in for the ones under
`~/.claude` and neither recall nor permission rules drift with the live files.
`AGENT_COPILOT_LOG_DIR` points at a throwaway dir to collect the stage
diagnostics without polluting the real log.

A scenario whose API call fails or times out is reported as `FAILED OPEN`: the
pipeline emits `{}` by design, which is otherwise indistinguishable from the
model deciding not to intervene.
