import { sharedRule } from './sharedRules.ts';

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
// The rules themselves are an editable shared rule (writing-plain-english.md).
// This opening line only frames the end-of-turn copy, so it stays here and
// the system block can use the editable rules whole.
const TURN_INTRO = 'How to write your reply (this sits at the end on purpose — follow it unless the message above asks for a specific format, an exact token, or silence: then do exactly that, including replying with only the token or not replying at all):';
export const plainEnglishWritingBlock = (): string => {
  const rules = sharedRule('writing-plain-english');
  return rules ? `${TURN_INTRO}\n${rules}` : '';
};

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
  const gemini = opts.cli === 'agy' || ((opts.cli === 'openrouter' || opts.cli === 'openrouter2') && /^~?google\/gemini/i.test(opts.model));
  return gemini ? plainEnglishWritingBlock() : '';
}

/** Native resumes retain their saved system prompt. Keep the full rules in
 * the fixed prompt for new sessions, and refresh ordinary human replies with
 * a short reminder so saved sessions also receive current writing guidance. */
export function plainEnglishWritingReminderFor(opts: { cli: string; model: string; voiceMode?: boolean; humanTurn?: boolean }): string {
  if (!plainEnglishWritingBlockFor(opts)) return '';
  return 'Writing reminder for this human reply: explain what you found and why it matters in plain, natural sentences in your usual voice. Reading a file is evidence for your reasoning, not a request to cite its path or helper names. Include paths, line numbers, IDs and implementation names only when requested or necessary for the person to act. Avoid repeated parenthetical asides. Preserve checked facts, qualifications and uncertainty; do not add details. Requested code, citations, exact tokens, formats, silence and your role style take priority.';
}

/** Full writing rules for a newly started native session. */
export function plainEnglishWritingSystemBlockFor(opts: { cli: string; model: string }): string {
  if (!plainEnglishWritingBlockFor(opts)) return '';
  return [
    'Keep each Write, Edit or shell-command payload below about 15 KB. Build large files with several bounded writes or edits, checking each result before continuing. Keep the whole job and its full scope; only the individual tool payloads are smaller.',
    'For ordinary human replies, use the writing rules below. A request for a specific format, an exact token or silence takes priority. For voice replies, follow the spoken style. Teammate messages, automation and continuation events follow their own reply instructions.',
    sharedRule('writing-plain-english'),
  ].join('\n');
}
