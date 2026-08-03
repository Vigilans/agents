# agents

Personal collection of reusable workflows and extensions for coding agents.

## Repository layout


```text
.
├── .agents/
│   ├── agents/                 # Agent definitions
│   └── skills/                 # Agent Skills
├── .claude/
│   ├── agents -> ../.agents/agents
│   └── skills -> ../.agents/skills
├── .claude-plugin/
│   └── marketplace.json        # Claude Code plugin marketplace
├── plugins/                    # Claude Code hook plugins
├── AGENTS.md                   # Shared agent instructions
└── CLAUDE.md                   # Claude Code instruction entry point
```

## Skills

Reusable instruction sets packaged as Agent Skills.

Install from this repository with the [`skills`](https://github.com/vercel-labs/skills) installer:

```shell
npx skills add Vigilans/agents
```

The installer discovers the skills under `.agents/skills` and lets you select both the skills and target coding agents. Add `--global` for a user-level installation instead of installing into the current project.

### [`compose-named-mappings`](.agents/skills/compose-named-mappings/SKILL.md)

Use the Named Mappings interpolation system implemented by forked [Vigilans/compose](https://github.com/Vigilans/compose) when writing Compose files.

The skill covers `${name[key]}` expressions and modifiers, global and resource mappings, cross-references, post-merge interpolation across `extends` and `include`, inline configs and secrets, path handling, and cycle detection.

### [`lmstudio-model-hub`](.agents/skills/lmstudio-model-hub/SKILL.md)

Register local GGUF models in LM Studio's model hub with publisher-qualified model identifiers.

The workflow covers model discovery, hub metadata generation, LM Studio model-data registration, and verification of the resulting model identifier.

## Agents

Agent definitions currently install by copying the desired Markdown file into the agent directory used by your client.

For a user-level Claude Code installation:

```shell
mkdir -p ~/.claude/agents
cp .agents/agents/re-analyst.md ~/.claude/agents/
```

### [`re-analyst`](.agents/agents/re-analyst.md)

A read-only reverse-engineering subagent for Ghidra CLI investigations, including decompilation, call-chain tracing, cross-reference analysis, structure recovery, and evidence-based reporting.

It requires Ghidra, a compatible JDK, `ghidra-cli`, and its companion `ghidra-cli` skill.

## Claude Code plugins

Hook-based extensions distributed through the `vigilans-agents` Claude Code plugin marketplace.

Add the marketplace once:

```text
/plugin marketplace add Vigilans/agents
```

Then install individual plugins:

```text
/plugin install subagent-model@vigilans-agents
/plugin install osc-notify@vigilans-agents
/plugin install agent-copilot@vigilans-agents
```

Apply newly installed plugins to the current session:

```text
/reload-plugins
```

### [`subagent-model`](plugins/subagent-model)

Overrides the model and permission mode used by Claude Code subagents, with global defaults and per-agent-type model overrides.

Arbitrary model names currently require the Agent hook model-override patch carried by the `dev` branch of [Vigilans/clawgod](https://github.com/Vigilans/clawgod), which patches Claude Code to accept an arbitrary Agent `model` returned in a `PreToolUse` hook's `updatedInput`.

### [`osc-notify`](plugins/osc-notify)

Routes Claude Code hook events to OSC 777 desktop notifications. Terminal sessions send `Notification` events to the active TTY with tmux passthrough, while VS Code sessions send contextual `PermissionRequest` and completed-response `Stop` notifications through the notifier integration with session click-back. VS Code delivery requires [Terminal Notification for VS Code](https://github.com/wbopan/vscode-terminal-osc-notifier), installed separately.

### [`agent-copilot`](plugins/agent-copilot)

Runs a transcript-aware second-opinion copilot that audits Claude Code's `UserPromptSubmit`, `PreToolUse`, `PostToolBatch`, and `Stop` events.

Stage 1 is a non-thinking classification pass: it replays the main agent context and routes only plausibly relevant checks, without making the hook decision itself. When checks are flagged, Stage 2 continues the same conversation with thinking enabled, evaluates only those checks against their full event-specific instructions, and synthesizes the final structured hook response. Events cleared by Stage 1 stop without intervention.

The built-in checks cover `AGENTS.md` discovery, auto-mode decisions, skill suggestions, and tool-call guards.

## Instructions

### [`AGENTS.md`](AGENTS.md)

The shared user-level instruction set used by this repository. It covers agent conduct, scope control, approval boundaries, verification, investigation reporting, and Git workflows.

### [`CLAUDE.md`](CLAUDE.md)

The Claude Code entry point that loads the installed `AGENTS.md`.
