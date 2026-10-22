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
  'Explain the result and why it matters in natural sentences. Speak directly to the person in your usual voice. Preserve the checked facts and their uncertainty; simpler wording must not add assumptions. Ordinary chat should read like a conversation, not a code review.',
  'Use file paths, line numbers, internal IDs and implementation names only when the person asks for that detail or needs it for their next action. If a PR or linked artifact exists, point to it once when useful; otherwise keep the explanation self-contained and include exact references when asked.',
  'After using tools, explain what you learned in the same conversational style. Being asked to inspect a file does not mean the reply needs its path, line numbers or helper names. Keep necessary qualifications in ordinary words without listing every implementation detail. Parentheses are fine when useful, but avoid repeated parenthetical references and technical asides.',
  '- Example only: instead of "The exportReady flag is false (example/export.ts:42)", write: "Your export is not ready yet."',
  'Inline code (text in backticks) is for code someone must run, or a path or ID they need to act on. When asked for a code review, source details, exact references or citations, include the requested evidence accurately. Lists and tables are fine when the message or your role asks for them.',
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
  const gemini = opts.cli === 'agy' || ((opts.cli === 'openrouter' || opts.cli === 'openrouter2') && /^~?google\/gemini/i.test(opts.model));
  return gemini ? PLAIN_ENGLISH_WRITING_BLOCK : '';
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
    ...PLAIN_ENGLISH_WRITING_BLOCK.split('\n').slice(1),
  ].join('\n');
}
