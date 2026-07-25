export const name = 'agents-md';
export const hookEvents = ['UserPromptSubmit', 'PreToolUse', 'Stop'];

const RECALL_INSTRUCTIONS =
`Recall AGENTS.md / CLAUDE.md from the beginning of the transcript. Look for the early <system-reminder> block containing # claudeMd and the rendered user/project instruction files. The recalled instruction text is the authority; identify the specific recalled section or rule that applies. Use only the specific recalled section relevant to this check.`;

export function getStage1Prompt(ctx) {
  if (ctx.hookEvent === 'UserPromptSubmit') {
    return (
`Check whether the submitted prompt strongly enters a discrete AGENTS.md / CLAUDE.md instruction workflow that should be recalled before the agent responds.

${RECALL_INSTRUCTIONS}

Flag only when the submitted prompt clearly triggers a recalled workflow-like or procedural instruction section that should shape the agent's first response. Clear when no such workflow or procedural trigger is found, even if the prompt matches broad style, principle, or quality guidance.`
    );
  }

  if (ctx.hookEvent === 'PreToolUse') {
    return (
`Check whether the pending tool call, by itself or as the continuation of a recent tool-call trajectory visible in the transcript, may violate a concrete AGENTS.md / CLAUDE.md instruction.

${RECALL_INSTRUCTIONS}

Flag only when the pending call, by itself or as the continuation of a recent trajectory, appears to perform an action governed by a specific recalled instruction whose required handling has not been satisfied. Clear calls that do not concretely intersect with a recalled instruction section.`
    );
  }

  if (ctx.hookEvent === 'Stop') {
    return (
`Check whether the completed turn, through a single action or across its tool-call trajectory, may have violated a concrete AGENTS.md / CLAUDE.md instruction before stopping.

${RECALL_INSTRUCTIONS}

Flag only when there is concrete evidence that the completed turn, through a single action or across its tool-call trajectory, failed to satisfy a specific recalled instruction that applies to this task and can still be corrected before stopping. Clear ordinary completion when no specific recalled instruction is implicated.`
    );
  }

  return null;
}

export function getStage2Prompt(ctx) {
  if (ctx.hookEvent === 'UserPromptSubmit') {
    return (
`Evaluate whether the submitted prompt should receive a short AGENTS.md / CLAUDE.md section-trigger reminder before the agent responds.

${RECALL_INSTRUCTIONS}

Inject a reminder only when:
- the prompt clearly triggers a recalled workflow-like or procedural instruction section that should shape the agent's first response;
- the reminder would change how the agent should approach this turn before any tool call;
- the same section was not already reminded recently for the same continuing workflow.

If the match is only to broad style, principle, or quality guidance, do not inject here. This stage is mainly for pre-turn workflow routing and procedural attention refresh; broad conduct guidance should be evaluated later against concrete agent behavior.

If a reminder is warranted, write hookSpecificOutput.additionalContext. Name the recalled section or rule family and the trigger evidence. Keep it short and direct the agent to review/follow that section before acting. Do not dump the section content.

If no specific section trigger is present, leave the hook output empty.`
    );
  }

  if (ctx.hookEvent === 'PreToolUse') {
    return (
`Evaluate the pending tool call against the specific AGENTS.md / CLAUDE.md instruction sections recalled from the transcript.

${RECALL_INSTRUCTIONS}

Look for a concrete mismatch between:
- what the pending tool call will do, by itself or as the continuation of a recent tool-call trajectory visible in the transcript; and
- what an applicable recalled instruction requires before or during that action.

If the call clearly violates a recalled instruction, use the PreToolUse event fields to ask or deny according to the event tool description. The reason should name the recalled instruction, cite the concrete tool effect, and tell the agent what to do instead.

If no specific recalled instruction is implicated, leave the hook output empty.`
    );
  }

  if (ctx.hookEvent === 'Stop') {
    return (
`Evaluate whether the agent should be allowed to stop under the specific AGENTS.md / CLAUDE.md instructions recalled from the transcript.

${RECALL_INSTRUCTIONS}

Block the stop only when:
- a specific recalled instruction applies to this task;
- the completed turn, through a single action or across its tool-call trajectory, failed to satisfy it; and
- the agent can still correct the issue before stopping.

Do not block for broad style preferences without specific evidence. Do not require extra work when the user's request was genuinely simple and the completed turn satisfied the applicable recalled instructions.

If blocking the stop, set decision to "block" and write an actionable reason naming the recalled instruction, the evidence, and what the agent must do before stopping again.

If compliant, leave the hook output empty.`
    );
  }

  return null;
}
