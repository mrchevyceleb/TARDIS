// Plain-English writing block for Gemini lanes (card-0d1015, Matt, Oct 17:
// "make gemini's text output be more plain english in chat"). The measured
// cause: Gemini lanes put the persona and every other instruction at the top
// of a very long message, with the one "how to write" line phrased as a list
// of don'ts buried deep inside. Gemini weights instructions placed after long
// context and follows a shown example better than a prohibition, so this
// block rides at the very END of each Gemini turn — the last thing the model
// reads — as short positive rules with one before/after example.
export const PLAIN_ENGLISH_WRITING_BLOCK = [
  'How to write your reply (this sits at the end on purpose — follow it):',
  'Write plain English sentences. Results, counts and statuses go in sentences, not code pills.',
  '- Write: "The build passed all 149 tests and the type check is clean."',
  '- Not: "149 (149/149) pass ✅ finish_reason: step_limit, tsc exit 0"',
  'Use a code pill only for real code someone must run, an exact file path, or an ID someone must act on. Everything else is a sentence.',
].join('\n');

/** True for the lanes this block rides: agy is Gemini-direct; the OpenRouter
 *  lane carries a per-agent model, so only its Gemini models get the block. */
export function wantsPlainEnglishBlock(cli: string, model: string): boolean {
  return cli === 'agy' || (cli === 'openrouter' && /^google\/gemini/i.test(model));
}
