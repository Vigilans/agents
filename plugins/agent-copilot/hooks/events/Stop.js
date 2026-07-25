export const hookEventName = 'Stop';

export const hookInputSchema = {
  type: 'object',
  properties: {
    stop_hook_active: { type: 'boolean' },
    last_assistant_message: { type: 'string' },
    background_tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    session_crons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          schedule: { type: 'string' },
          recurring: { type: 'boolean' },
          prompt: { type: 'string' },
        },
      },
    },
  },
};

export const hookOutputSchema = {
  type: 'object',
  properties: {
    systemMessage: { type: 'string' },
    continue: { type: 'boolean' },
    stopReason: { type: 'string' },
    suppressOutput: { type: 'boolean' },
    decision: { enum: ['block'] },
    reason: { type: 'string' },
  },
  additionalProperties: false,
};

export const stage1ToolDescription =
`Classify candidate checks that need Stage 2 deeper evaluation for the current Stop invocation.

Stop fires when the agent has signalled completion of its turn. The full conversation transcript is available for reviewing what the agent did during the turn.

Decision rules:
- For each candidate, decide independently whether the completed turn is clearly acceptable under that check's stated criteria. If so, omit the candidate from flags.
- Add the candidate name to flags if, under that check's criteria, the turn might warrant blocking the stop and forcing the agent to continue.

Conservatism:
- Stop is an end-of-turn checkpoint. Judge the completed turn against the user's request and the visible work in the transcript; do not use shortcuts like answer length, apparent task simplicity, "quick fix", or tool-call count as automatic clear/flag rules.
- Flag when a candidate could reasonably find an end-of-turn issue: unfinished work, skipped workflow, premature or superficial completion of work that required investigation or validation, scope drift, or unresolved user/project instruction. Clear ordinary completion only when no candidate's criteria plausibly apply.`;

export const stage2ToolDescription =
`Record the final decision for the Stop hook by calling this tool with the decision encoded in its input.

Stop fires when the agent has signalled completion of its turn. The input fields below tell Claude Code whether to let the agent stop or force it to continue working.

Decision fields:

- decision — whether to block the stop:
    "block"  force the agent to continue; it will see the reason and resume
    omit     let the agent stop normally

- reason — required when decision="block". Write actionable feedback for the agent: the concrete end-of-turn issue, the evidence, and what it should do before stopping again.

Decision conservatism:
- Use "block" only when a flagged check found a specific end-of-turn issue the agent can still address.
- The reason should name the missing action or correction, not summarize the check.`;

export function getStage1Prompt(ctx, checks) {
  const candidates = [];
  for (const check of checks) {
    const prompt = check.getStage1Prompt(ctx);
    if (prompt !== null) candidates.push({ name: check.name, prompt });
  }
  if (candidates.length === 0) return null;

  const checkSections = [];
  for (const c of candidates) {
    checkSections.push(
`### ${c.name}
${c.prompt}`);
  }

  const priorBlock = ctx.hookInput?.stop_hook_active === true
    ? ' This Stop fired with stop_hook_active set: the agent was already blocked at a previous Stop in this session, and this turn is its response to that block.'
    : '';

  return (
`The agent has signalled completion of its turn.${priorBlock}

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
`Evaluate the following flagged checks for this stop event.

${sections.join('\n\n')}`
  );
}

// Stop can fire before Claude Code flushes the final assistant turn to the
// transcript; the reply is carried out-of-band in `last_assistant_message`.
// True once that text has landed on disk as an assistant text block.
export function isTranscriptReady(ctx, tailMessages) {
  const target = ctx.hookInput?.last_assistant_message;
  if (typeof target !== 'string' || target.length === 0) return true; // nothing to wait for
  return tailMessages.some(
    (m) =>
      m.role === 'assistant' &&
      m.content.some((b) => b.type === 'text' && b.text === target),
  );
}

// Same attribution marking as PreToolUse's postProcessHookOutput, idempotent.
const BLOCKED_PREFIX = 'BLOCKED by Agent Copilot';

export function postProcessHookOutput(output) {
  if (output?.decision !== 'block') return output;
  const reason = output.reason;
  if (typeof reason !== 'string' || reason === '' || reason.startsWith(BLOCKED_PREFIX)) return output;
  return {
    ...output,
    reason: `${BLOCKED_PREFIX}\n\nReason: ${reason}`,
  };
}
