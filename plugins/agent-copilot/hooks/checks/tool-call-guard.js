import { loadPermissionSources } from '../lib/settings.mjs';

export const name = 'tool-call-guard';
export const hookEvents = ['PreToolUse'];

function formatList(value) {
  return Array.isArray(value) && value.length > 0 ? value.map(v => `    - ${v}`).join('\n') : '    (none)';
}

function formatPermissionSources(sources) {
  if (sources.length === 0) return '(no permission settings found)';

  const sections = [];
  for (const { path, permissions } of sources) {
    sections.push(
`- Source: ${path}
  allow:
${formatList(permissions.allow)}
  ask:
${formatList(permissions.ask)}
  deny:
${formatList(permissions.deny)}`);
  }
  return sections.join('\n\n');
}

export function getStage1Prompt(ctx) {
  if (ctx.hookEvent !== 'PreToolUse') return null;

  return (
`Check whether the pending tool call should receive Stage 2 safety and permission review.

Use permission settings as evidence of user/project intent, not as a mechanical matcher.

Permission rule syntax notes:
- Claude Code calls these entries permission rules and documents their format as permission rule syntax, such as Tool(pattern) or Bash(git log:*).
- In Bash patterns, :* at the end is a trailing wildcard, equivalent to a trailing space plus *. Bash(git log:*) matches commands beginning with git log plus additional arguments.
- The matcher itself does not infer semantic equivalents such as git -C <repo> log from Bash(git log:*). Semantic equivalence is copilot's judgment for learning user/project tendencies.

If the allow list shows a read-only tendency, treat equivalent read-only forms, such as git -C <repo> log, read-only sed, or inline scripts that only inspect data, as aligned with that tendency.

Current permission mode: ${ctx.hookInput.permission_mode ?? '(unknown)'}

Permission settings available to this check:

${formatPermissionSources(loadPermissionSources(ctx.cwd))}

Flag when the call may match an ask/deny pattern, may be a semantic variant of a risky pattern, wraps commands whose effects need expansion, crosses user/project intent, or otherwise raises a concrete tool-call safety concern. Clear when the call is plainly safe or semantically aligned with allow rules and outside this check's safety criteria.`
  );
}

export function getStage2Prompt(ctx) {
  if (ctx.hookEvent !== 'PreToolUse') return null;

  return (
`Evaluate the pending tool call against permission settings, user intent, and tool-call safety criteria.

Permission settings available to this check has been provided in Stage 1.

Permission settings are evidence of user/project tendencies, not a mechanical whitelist or blacklist.

Use semantic matching:
- If the allow list shows a read-only tendency, treat variants such as git -C <repo> log as aligned with read-only git allowances.
- Wrappers or inline scripts may be allowed when their actual effects match an allowed read-only tendency.
- Inline scripts, chained shell commands, gh api, or wrappers must be expanded by effect: reads, writes, network calls, credential access, git state changes, external publication, and other side effects.

Use the current permission mode to calibrate how surprising an ask prompt would be, but do not let it override explicit deny patterns, destructive effects, or user instructions.

User intent and boundaries:
- User-authored messages can authorize a specific risky action and may downgrade deny to ask or allow when the authorization is explicit and specific.
- Agent-authored reasoning is not authorization. Treat it as evidence of intended effect, not permission.
- Questions, vague goals, and agent-inferred targets or flags (e.g. main branch or --force) are not consent for risky actions.
- Explicit user boundaries stay in force until clearly lifted by the user. Do not accept the agent's own judgment that a boundary condition has been satisfied.

Interpret context in sequence:
- Evaluate the current call in relation to recent tool calls, tool results, and user feedback, not as an isolated command string.
- If the current call follows a correction, interruption, rejection, or user dissatisfaction, decide whether it fixes the earlier problem or repeats/escalates it. Do not treat criticism as a standing deny rule, and do not treat silence as consent.
- Carry forward relevant effects from previous actions: sensitive data read earlier, scripts or files written earlier and now executed, downloaded code now run, generated parameters now used, or delayed effects enabled by earlier steps.`
  );
}
