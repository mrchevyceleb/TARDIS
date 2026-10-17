// Plain-English writing block for Gemini lanes (card-0d1015, Matt, Oct 17:
// "make gemini's text output be more plain english in chat"). The measured
// cause: Gemini lanes put the persona and every other instruction at the top
// of a very long message, with the one "how to write" line phrased as a list
// of don'ts buried deep inside. Gemini weights instructions placed after long
// context and follows a shown example better than a prohibition, so this
// block rides at the very END of each Gemini turn — the last thing the model
// reads — as short positive rules with one before/after example.
//
// Scope (review 1): it names the real artifact (inline code in backticks,
// which the app renders as pills) rather than the app's own UI word, yields to
// explicit format requests and role styles, and never overrides a request for
// silence or an exact token. It rides only human turns on Gemini lanes —
// voice turns keep their own spoken-style addendum, and automation, peer and
// continuation turns must stay silent or exact.
export const PLAIN_ENGLISH_WRITING_BLOCK = [
  'How to write your reply (this sits at the end on purpose — follow it unless the message above asks for a specific format, an exact token, or silence: then do exactly that, including replying with only the token or not replying at all):',
  'Write plain English sentences. Results, counts and statuses go in sentences, not inline code.',
  '- If 149 tests passed, write: "The build passed all 149 tests and the type check is clean."',
  '- Not: "`149/149` pass, `finish_reason: step_limit`, `tsc` exit `0` ✅"',
  'Inline code (text in backticks) is only for real code someone must run, an exact file path, or an ID someone must act on. Lists and tables are fine when the message or your role asks for them.',
].join('\n');

/** The block for one turn, or '' when the turn must not carry it: voice turns
 *  (their spoken-style addendum forbids code, paths and IDs outright),
 *  non-human turns (automation, peer and continuation traffic must stay
 *  silent or emit an exact token — a last-position writing rule would push
 *  Gemini to chatter instead), and every lane that is not Gemini. agy is
 *  Gemini-direct; the OpenRouter lane carries a per-agent model, so only its
 *  Gemini models get the block, including ~-prefixed alias ids. */
export function plainEnglishWritingBlockFor(opts: { cli: string; model: string; voiceMode?: boolean; humanTurn?: boolean }): string {
  if (opts.voiceMode) return '';
  if (opts.humanTurn === false) return '';
  const gemini = opts.cli === 'agy' || (opts.cli === 'openrouter' && /^~?google\/gemini/i.test(opts.model));
  return gemini ? PLAIN_ENGLISH_WRITING_BLOCK : '';
}
