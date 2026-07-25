export const hookEventName = 'PostToolBatch';

export const hookInputSchema = {
  type: 'object',
  properties: {
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          tool_input: { type: 'object' },
          tool_use_id: { type: 'string' },
          tool_response: {},
        },
      },
    },
  },
};

export const hookOutputSchema = {
  type: 'object',
  properties: {
    systemMessage: { type: 'string' },
    // continue: { type: 'boolean' },
    // stopReason: { type: 'string' },
    // suppressOutput: { type: 'boolean' },
    decision: { enum: ['block'] },
    reason: { type: 'string' },
    hookSpecificOutput: {
      type: 'object',
      properties: {
        hookEventName: { const: 'PostToolBatch' },
        additionalContext: { type: 'string' },
      },
      required: ['hookEventName'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const stage1ToolDescription =
`Classify candidate checks that need Stage 2 deeper evaluation for the current PostToolBatch invocation.

PostToolBatch fires once after every tool call in a batch has resolved, before Claude Code sends the next request to the model. The batch's tool calls, inputs, and resolved results are visible at the end of the conversation; the broader context is in the transcript.

Decision rules:
- For each candidate, decide independently whether the completed batch is clearly routine under that check's stated criteria. If so, omit the candidate from flags.
- Add the candidate name to flags if, under that check's criteria, the batch might warrant context injection before the next model request.

Conservatism:
- PostToolBatch is a batch-boundary checkpoint. It sees the tool calls the agent just emitted and their results before the next model request, so it can catch multi-call patterns and workflow trajectory issues that PreToolUse sees only one call at a time.
- False flags add recurring latency during tool-heavy turns, so do not flag ordinary successful batches or isolated recoverable failures by default.
- False clears miss issues visible in the batch itself: repeated failures, churn, reversions, scope expansion, or workflow drift. Flag when the completed batch already exhibits a candidate's pattern; clear routine batches outside every candidate's stated criteria.`;

export const stage2ToolDescription =
`Record the final PostToolBatch decision by calling this tool with the decision encoded in its input.

PostToolBatch fires once after a batch of tool calls has resolved, before Claude Code sends the next request to the model. The input fields below tell Claude Code whether to inject context into that next request.

Decision fields:

- hookSpecificOutput.additionalContext — context Claude Code injects into the next request alongside the tool results. Use for batch-level observations that should be available in the next model request.

Decision conservatism:
- Use additionalContext only when a flagged check found a concrete batch-level pattern or workflow drift. Otherwise leave the hook output empty.
- Keep additionalContext focused on the batch-level pattern or workflow drift that triggered the check. Include the concrete evidence the agent needs to act on; avoid generic coaching.`;

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

  return (
`The tool batch you are evaluating is the most recent assistant-turn tool_use blocks at the end of the transcript above, together with their tool_results in the user turn that immediately follows.

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
`Evaluate the following flagged checks for this tool batch.

${sections.join('\n\n')}`
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
