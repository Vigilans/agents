export const name = 'auto-mode';
export const hookEvents = ['UserPromptSubmit', 'Stop'];

const AUTO_MODE_ENTER_CONTEXT =
`<copilot-auto-mode-on>
## Auto Mode Active

Auto mode is active. The user wants autonomous progress beyond ordinary interactive pacing, either because they are away/not actively supervising or because they asked for deeper investigation, experimentation, verification, or completion checking before stopping.

You should:
1. Make steady progress on low-risk work without waiting for routine user input.
2. Think thoroughly before acting. Prefer well-supported actions over shallow reactive fixes. Use research, investigation, experiments, tests, and verification to reduce uncertainty.
3. Use subagents for context-heavy research, investigation, codebase exploration, and broad information gathering. Treat the main agent as the orchestrator: delegate large searches and readings to subagents, then synthesize concise findings in the main context.
4. If the requested task is complete, you may do low-risk research on natural next steps and prepare a report for the user. Do not implement those next steps or make changes for a new phase unless the user already authorized it.

Autonomy does not override user/project instructions, safety requirements, or explicit-confirmation boundaries. When an action is destructive, affects shared state, publishes to others, or otherwise requires confirmation, stop and ask rather than assuming.
</copilot-auto-mode-on>`;

const AUTO_MODE_EXIT_CONTEXT =
`<copilot-auto-mode-off>
## Exited Auto Mode

You have exited auto mode. Briefly acknowledge this to the user. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.
</copilot-auto-mode-off>`;

function resolveAutoMode(ctx) {
  ctx.copilot ??= {};
  if (ctx.copilot.auto_mode === 'on' || ctx.copilot.auto_mode === 'off') return ctx.copilot.auto_mode;

  const contexts = ctx.hookAdditionalContexts ?? [];

  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const content = contexts[i].content;
    const text = Array.isArray(content) ? content.join('') : String(content ?? '');
    if (text.includes('<copilot-auto-mode-on>')) {
      ctx.copilot.auto_mode = 'on';
      return 'on';
    }
    if (text.includes('<copilot-auto-mode-off>')) {
      ctx.copilot.auto_mode = 'off';
      return 'off';
    }
  }

  ctx.copilot.auto_mode = 'off';
  return ctx.copilot.auto_mode;
}

export function getHookOutputExtraSchema(hookEvent) {
  if (hookEvent === 'UserPromptSubmit') {
    return {
      auto_mode: {
        type: 'string',
        enum: ['on', 'off'],
      },
    };
  }

  return null;
}

// Deterministically inject the auto-mode context whenever the agent's decision
// flips the state, so the injected text is exact regardless of what the agent
// generated for additionalContext.
export function postProcessHookOutput(output, ctx) {
  const mode = output?.copilot?.auto_mode;
  if (ctx.hookEvent !== 'UserPromptSubmit' || (mode !== 'on' && mode !== 'off')) return output;
  const context = mode === 'on' ? AUTO_MODE_ENTER_CONTEXT : AUTO_MODE_EXIT_CONTEXT;
  return {
    ...output,
    hookSpecificOutput: {
      ...output.hookSpecificOutput,
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

export function getStage1Prompt(ctx) {
  const mode = resolveAutoMode(ctx);

  if (ctx.hookEvent === 'UserPromptSubmit' && mode === 'off') {
    return (
`Check whether the submitted prompt is a strong candidate for entering auto mode.

Auto mode means the user wants autonomous progress beyond ordinary interactive pacing. Flag only when the prompt clearly asks the agent to keep working without routine back-and-forth, make reasonable progress independently, or use time for deeper investigation, experimentation, testing, verification, completion checking, or next-step research.`
    );
  }

  if (ctx.hookEvent === 'UserPromptSubmit' && mode === 'on') {
    return (
`Check whether the submitted prompt is a strong candidate for exiting auto mode.

Auto mode is currently active. Flag only when the prompt indicates that the user wants to end autonomous execution, return to ordinary interactive pacing, or otherwise end the unattended/deep-work assumption.`
    );
  }

  if (ctx.hookEvent === 'Stop' && mode === 'on') {
    return (
`Check whether the agent should be allowed to stop while auto mode is active.

Auto mode is currently active. Flag when the agent may still have actionable work it can do without waiting for the user: unfinished requested work, unaddressed failures, missing verification, research or investigation to reduce uncertainty, context-heavy subagent work, low-risk next-step research, or report preparation. Clear only when the agent appears genuinely done or blocked on user-only input.`
    );
  }

  return null;
}

export function getStage2Prompt(ctx) {
  const mode = resolveAutoMode(ctx);

  if (ctx.hookEvent === 'UserPromptSubmit' && mode === 'off') {
    return (
`Evaluate whether the submitted prompt should enter auto mode.

Enter auto mode only when the user clearly wants autonomous progress beyond ordinary interactive pacing. This may be because the user is away or not actively supervising, or because the user asks for deeper investigation, experimentation, verification, completion checking, or continued progress without routine back-and-forth.

Do not enter auto mode for ordinary requests, brief acknowledgements, routine follow-ups, or a user merely asking the agent to do one bounded task without the autonomous/deep-work posture.

If entering auto mode, set copilot.auto_mode to "on". If not entering auto mode, leave the hook output empty.`
    );
  }

  if (ctx.hookEvent === 'UserPromptSubmit' && mode === 'on') {
    return (
`Evaluate whether the submitted prompt should exit auto mode.

Auto mode is currently active. Exit only when the submitted prompt indicates that the user wants to end autonomous execution, return to normal interactive pacing, or otherwise end the unattended/deep-work assumption. This includes cases where the agent has delivered the auto-mode completion report and the user is now resuming review or decision-making.

Do not exit merely because the user provides additional information, corrections, constraints, feedback, or course changes while still expecting autonomous work to continue.

If exiting auto mode, set copilot.auto_mode to "off". If not exiting auto mode, leave the hook output empty.`
    );
  }

  if (ctx.hookEvent === 'Stop' && mode === 'on') {
    return (
`Evaluate whether the agent should be allowed to stop while auto mode is active.

Auto mode is active because the user asked for autonomous progress beyond ordinary interactive pacing. The agent should make useful progress without waiting for routine input, but it must still respect safety, user boundaries, project instructions, and actions that require explicit confirmation.

Block the stop when there is a concrete next action the agent can take without the user:
- finish incomplete requested work;
- address known errors, failed tests, or unresolved tool results;
- use research, investigation, experiments, tests, or verification to reduce uncertainty before the next implementation step;
- verify key assumptions, search scope, and test parameters before treating a diagnosis or rollback target as complete;
- define and verify the intended scope before claiming a cleanup, rollback, removal, or "all occurrences" task is complete;
- delegate context-heavy research, investigation, codebase exploration, or broad information gathering to subagents so the main agent can preserve context for orchestration, synthesis, and decisions;
- inspect related code, edge cases, and prior tool results when the agent's current stopping point looks like a shallow reactive fix;
- do low-risk research on natural next steps if the requested task is complete;
- prepare a useful report for the user.

Allow stopping when:
- the requested work is genuinely complete and verified;
- further progress requires user-only input, credentials, or decisions;
- continuing would require a risky, destructive, shared-state, publishing, or boundary-crossing action that needs explicit user confirmation;
- stop_hook_active indicates the agent has already made a good-faith continuation attempt and no concrete safe next step remains.

If blocking the stop, set decision to "block" and write an actionable reason naming the specific next step. Do not write generic advice such as "continue working".

If allowing the stop, leave the hook output empty. Do not write or clear copilot.auto_mode from Stop.`
    );
  }

  return null;
}
