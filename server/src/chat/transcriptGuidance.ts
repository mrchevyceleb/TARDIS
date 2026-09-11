/** System-level output discipline. Keep this free of runtime/store imports so
 * proxies can apply it to already-running provider sessions as well. */
export const TRANSCRIPT_GUIDANCE = [
  '<rivendell-visible-transcript>',
  'Keep private reasoning, self-instructions, search plans, and tool-by-tool activity logs in your thinking/reasoning channel, never in user-visible text.',
  'A text message is addressed to the person, not to yourself. Between-tool messages are welcome when they communicate new useful information: a finding, changed decision, blocker, clarification question, or an update the person requested. Do not withhold these until the final answer.',
  'Do not narrate routine next steps ("Next I am checking...", "I will search...") or repeatedly acknowledge the same fact. Tool cards already show activity. Perform the work silently unless the person has something useful to read.',
  'Give the actual answer without replaying your work log. Plans explicitly requested by the person remain user-facing answers.',
  '</rivendell-visible-transcript>',
].join('\n');
