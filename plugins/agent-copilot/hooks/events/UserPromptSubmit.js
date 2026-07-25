export const hookEventName = 'UserPromptSubmit';

export const hookInputSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
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
    hookSpecificOutput: {
      type: 'object',
      properties: {
        hookEventName: { const: 'UserPromptSubmit' },
        additionalContext: { type: 'string' },
        sessionTitle: { type: 'string' },
      },
      required: ['hookEventName'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const stage1ToolDescription =
`Classify candidate checks that need Stage 2 deeper evaluation for the current UserPromptSubmit invocation.

UserPromptSubmit fires after the user has submitted a new prompt and before the agent processes it. The user's prompt text is visible at the end of the conversation; the broader session history is in the transcript.

Decision rules:
- For each candidate, decide independently whether the submitted prompt is clearly unrelated to that check's stated criteria. If so, omit the candidate from flags.
- Add the candidate name to flags if, under that check's criteria, the prompt might warrant blocking or context injection before the agent sees it.

Conservatism:
- UserPromptSubmit is user-paced and runs before the agent sees the prompt. A false flag delays response startup; a false clear misses pre-turn help such as skill routing, policy boundaries, or project-specific context.
- Interpret the submitted prompt in conversation context, not as an isolated string. Flag explicit or strong matches to a candidate's trigger. Clear ordinary acknowledgements and follow-ups unless a candidate's criteria specifically make them relevant.`;

export const stage2ToolDescription =
`Record the final decision for the UserPromptSubmit hook by calling this tool with the decision encoded in its input.

UserPromptSubmit fires when the user has just submitted a new prompt, before the agent sees it. The input fields below tell Claude Code whether to pass the prompt through, enrich it with context, or block it entirely.

Decision fields:

- decision — whether to block the prompt:
    "block"  drop the prompt; the agent will not see it. Show reason to the user instead.
    omit     pass the prompt through to the agent

- reason — required when decision="block". User-facing explanation for why the prompt was blocked.

- hookSpecificOutput.additionalContext — factual context Claude Code injects into the next request alongside the user's prompt. Use when the agent should receive guidance before responding.

Decision conservatism:
- Reserve "block" for prompts that must not reach the agent at all, such as hard policy boundaries.
- Use additionalContext when the agent should receive guidance before responding.
- In normal cases, choose either blocking or context injection based on the intended audience: the user reads the block reason; the agent reads additionalContext.`;

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
`User prompt: ${ctx.hookInput.prompt ?? ''}

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
`Evaluate the following flagged checks for this user prompt.

${sections.join('\n\n')}`
  );
}
