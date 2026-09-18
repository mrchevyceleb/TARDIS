// The ship's voice — every themed line of copy that is not a room name.
// Keep it here so the tone can be tuned in one file.

export const BRAND = 'TARDIS';
export const TAGLINE = 'Bigger on the inside.';
export const WORKSPACE_NAV = { label: 'Workspace view', chat: 'Chat' };

/** Shown in the live-turn pill, rotating every ~3 s. Each still means "working". */
export const THINKING_PHRASES = [
  'reversing the polarity',
  'consulting the time rotor',
  'scanning the timeline',
  'running the telepathic circuits',
  'wibbly-wobbly, timey-wimey…',
  'plotting a course through the vortex',
  'reading the psychic paper',
  'warming up the chameleon circuit',
];

/** One per regeneration divider, picked deterministically per block. */
export const REGEN_QUOTES = ['Same agent, new face.', "I don't want to go.", "Hello. I'm the Doctor. Basically… run."];

export const TIMEY_WIMEY = 'wibbly-wobbly, timey-wimey…';

/** Rotating empty-composer placeholders. Returns a fresh array — callers must
    useMemo it, because the Composer's rotation effect keys on identity. */
export function composerPlaceholders(agentName: string): string[] {
  return [
    `Message ${agentName}`,
    'Where to, Doctor?',
    'All of time and space — where do we start?',
    `Give ${agentName} a mission`,
    '/ for console commands',
    'Ask for a plan, a brief, or a fixed point',
    'Allons-y — what needs doing?',
    'Bigger on the inside. Try it.',
  ];
}

const STATUS_LABELS: Record<string, string> = {
  connecting: 'Materialising…',
  ready: 'Ready',
  streaming: 'In flight',
  closed: 'Dematerialised',
  error: 'Error — dematerialised',
};

/** Transport status → console wording. Unknown statuses pass through. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
