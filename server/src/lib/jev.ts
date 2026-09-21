/** TypeSafe Jev — a System One model for fast, calibrated yes/no decisions.
 *
 *  Not a chat model. One request carries a `state` (the thing to judge) and a
 *  map of Noul questions; the answer to each is a probability that "yes" is
 *  correct, evaluated in parallel, typically in a few hundred milliseconds.
 *  TARDIS uses it as a GATE in front of expensive agent turns: decide cheaply
 *  whether there is anything worth waking a frontier model for.
 *
 *  Disabled until TYPESAFE_API_KEY is configured; callers must check
 *  jevConfigured() and keep a non-Jev path. */

const JEV_URL = process.env.TYPESAFE_API_URL?.trim() || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.TYPESAFE_MODEL?.trim() || 'jev-latest';

export type NoulQuestion = {
  /** A yes/no question phrased so that "yes" is the high value, or a
   *  structured object carrying supporting fields plus a `question`. */
  instructions: string | Record<string, unknown>;
  /** Clarify subtle boundaries. Optional. */
  criteria?: { true: string; false: string };
};

export function jevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

/** Ask a batch of Noul questions about one state. Returns question id ->
 *  probability of yes (0..1). Throws on transport or auth failure so the
 *  caller can fall back; never returns a partial map. */
export async function jevNouls(
  state: unknown,
  questions: Record<string, NoulQuestion>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, number>> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error('TYPESAFE_API_KEY is not configured');
  if (Object.keys(questions).length === 0) return {};
  const body = {
    model: JEV_MODEL,
    state,
    questions: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [id, { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }]),
    ),
  };
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)])
    : AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const response = await fetch(JEV_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jev ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json() as { answers?: Record<string, { type?: string; noul?: number }> };
  const out: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const value = data.answers?.[id]?.noul;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Jev returned no answer for ${id}`);
    out[id] = value;
  }
  return out;
}
