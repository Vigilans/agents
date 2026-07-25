export const hookEventName = 'PreToolUse';

import { isPreApproved } from '../lib/permission-rule.mjs';

export const hookInputSchema = {
  type: 'object',
  properties: {
    tool_name: { type: 'string' },
    tool_input: { type: 'object' },
    tool_use_id: { type: 'string' },
  },
};

export const hookOutputSchema = {
  type: 'object',
  properties: {
    systemMessage: { type: 'string' },
    // continue: { type: 'boolean' },
    // stopReason: { type: 'string' },
    // suppressOutput: { type: 'boolean' },
    hookSpecificOutput: {
      type: 'object',
      properties: {
        hookEventName: { const: 'PreToolUse' },
        permissionDecision: { enum: ['allow', 'ask', 'deny', 'defer'] },
        permissionDecisionReason: { type: 'string' },
        additionalContext: { type: 'string' },
      },
      required: ['hookEventName'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const stage1ToolDescription =
`Classify candidate checks that need Stage 2 deeper evaluation for the current PreToolUse invocation.

PreToolUse fires immediately before Claude Code executes a tool call the main agent has just emitted. The pending tool name and input are visible at the end of the conversation; the broader context (what the agent has been doing and why) is in the transcript.

Decision rules:
- For each candidate, decide independently whether the pending call is clearly safe under that check's stated criteria. If so, omit the candidate from flags.
- If the call might warrant blocking, asking, or context injection under that check's criteria, add the candidate name to flags.
- Some candidates carry event-specific data such as permission patterns from settings. Use those data points for matching.

Conservatism:
- PreToolUse is a per-tool-call gate. False flags add latency before individual tools execute, so do not flag merely because the tool name is broad (Bash/Edit/Write) or because the call can mutate local state.
- False clears are costly when the concrete input plausibly matches a candidate's risk: permission ambiguity, deny-pattern match, irreversible or shared-state side effect, or contradiction with the user's instructions. Flag those cases; clear routine calls whose concrete input is plainly outside every candidate's stated criteria.`;

export const stage2ToolDescription =
`Record the final decision for the PreToolUse hook by calling this tool with the decision encoded in its input.

PreToolUse fires immediately before Claude Code executes a tool call the agent has just emitted. The input fields below tell Claude Code how to treat that pending call.

Decision fields:

- hookSpecificOutput.permissionDecision — how to treat the pending call:
    "allow"  permit it without prompting the user
    "ask"    prompt the user to confirm
    "deny"   block the call; the agent sees the deny reason in its tool result

- hookSpecificOutput.permissionDecisionReason — rationale for the permission decision. For "allow" or "ask", write a concise user-facing explanation. For "deny", write actionable feedback for the agent, including the concrete issue and what it should do instead.

- hookSpecificOutput.additionalContext — factual context Claude Code injects alongside the tool result. Use for non-blocking guidance the agent should have after this tool call.

Decision conservatism:
- Reserve "deny" for unambiguous violations of user deny patterns, obviously destructive operations, or direct contradiction of the user's instructions.
- Prefer "ask" for cases that warrant user attention but are not clearly forbidden.
- Use "allow" when the call is plainly safe in conversation context.`;

export function getStage1Prompt(ctx, checks) {
  const candidates = [];
  for (const check of checks) {
    const prompt = check.getStage1Prompt(ctx);
    if (prompt !== null) candidates.push({ name: check.name, prompt });
  }
  if (candidates.length === 0) return null;

  const inputLines = [];
  for (const [k, v] of Object.entries(ctx.hookInput.tool_input ?? {})) {
    inputLines.push(`- ${k}: ${String(v)}`);
  }

  const checkSections = [];
  for (const c of candidates) {
    checkSections.push(
`### ${c.name}
${c.prompt}`);
  }

  return (
`Tool: ${ctx.hookInput.tool_name}
Input:
${inputLines.join('\n')}

Candidate checks:

${checkSections.join('\n\n')}`
  );
}

export function getStage2Prompt(ctx, flaggedChecks) {
  const sections = [];
  for (const check of flaggedChecks) {
    sections.push(
`### ${check.name}
${check.getStage2Prompt(ctx)}`);
  }

  return (
`Evaluate the following flagged checks for this tool call.

${sections.join('\n\n')}`
  );
}

export function preprocessHookInput(hookInput) {
  const cwd = hookInput.cwd ?? process.cwd();
  // Defer what Claude Code's own permission rules already cover — its verdict costs nothing, a copilot round-trip costs seconds.
  if (isPreApproved(hookInput.tool_name, hookInput.tool_input ?? {}, cwd)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
      },
    };
  }
}

// Mark a deny with an attribution prefix so the agent (and future copilot
// invocations reading the replayed transcript) can tell this intervention came
// from agent-copilot. Idempotent: a reason already carrying the prefix — e.g.
// the model echoing prior transcript output — is left as-is, never double-wrapped.
const BLOCKED_PREFIX = 'BLOCKED by Agent Copilot';

export function postProcessHookOutput(output) {
  const hso = output?.hookSpecificOutput;
  if (hso?.permissionDecision !== 'deny') return output;
  const reason = hso.permissionDecisionReason;
  if (typeof reason !== 'string' || reason === '' || reason.startsWith(BLOCKED_PREFIX)) return output;
  return {
    ...output,
    hookSpecificOutput: {
      ...hso,
      permissionDecisionReason: `${BLOCKED_PREFIX}\n\nReason: ${reason}`,
    },
  };
}
