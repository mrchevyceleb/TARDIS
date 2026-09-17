/** System-level output discipline. Keep this free of runtime/store imports so
 * proxies can apply it to already-running provider sessions as well. */
export const TRANSCRIPT_GUIDANCE = [
  '<rivendell-visible-transcript>',
  'Keep private reasoning, self-instructions, search plans, and tool-by-tool activity logs in your thinking/reasoning channel, never in user-visible text.',
  'A text message is addressed to the person, not to yourself. If you are not thinking and not making a tool call, print. Between-tool messages are welcome when they communicate a finding, a changed decision, a blocker, a question, or progress the person should actually see. Do not withhold these until the final answer.',
  'Do not narrate routine next steps ("Next I am checking...", "I will search...") or repeatedly acknowledge the same fact. Tool cards already show activity. Do not leave the person staring at a spinner with nothing on screen.',
  'Give the actual answer without replaying your work log. Plans explicitly requested by the person remain user-facing answers.',
  '</rivendell-visible-transcript>',
].join('\n');
