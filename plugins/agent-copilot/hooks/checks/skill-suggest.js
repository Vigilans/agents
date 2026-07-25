export const name = 'skill-suggest';
export const hookEvents = ['UserPromptSubmit'];

export function getStage1Prompt(ctx) {
  if (ctx.hookEvent !== 'UserPromptSubmit') return null;

  return (
`Check whether the submitted prompt is a strong candidate for a skill suggestion.

Flag when the prompt appears to explicitly match an available skill's trigger description. Clear when the match is vague, speculative, covered by ordinary tools, or depends on guessing between multiple similarly plausible skills.`
  );
}

export function getStage2Prompt(ctx) {
  if (ctx.hookEvent !== 'UserPromptSubmit') return null;

  return (
`Evaluate whether the submitted prompt should receive a skill suggestion before the agent responds.

The available skills are listed earlier in the transcript in a <system-reminder> block. Suggest a skill only when all of these hold:

- The prompt clearly matches a skill's trigger description.
- The skill would add concrete value beyond ordinary tool use or general reasoning.
- The user did not already invoke the skill directly with a slash command.
- If multiple skills match, one skill is clearly the most specific fit.

Calibration:

- For project, workflow, configuration, review, security, or domain-specific skills, trust the skill description. Suggest the skill when the prompt clearly falls inside its trigger.
- For web search or extraction skills, do not suggest the skill for ordinary search/fetch requests when ordinary web/search/fetch tools are available and sufficient. Suggest only when the prompt calls for a specialized capability from the skill description, such as JavaScript-rendered extraction, batch URL extraction, site mapping/crawling, query-focused extraction, or deep research, or when the available tool context makes the skill the appropriate search/fetch path in this environment.
- For skills that fetch up-to-date library documentation, suggest them when the user needs current API docs, signatures, setup guidance, or version-sensitive library behavior.

If no skill is a strong match, leave the hook output empty.

If a skill should be suggested, write hookSpecificOutput.additionalContext for the agent. Include the exact skill name from the skill listing and the trigger evidence. Do not say the skill is mandatory; suggest it as the relevant tool to consider.`
  );
}
