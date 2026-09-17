// Room labels — the single source of truth for what each room is CALLED.
// Route keys (/council, /api/weavings, the ROOMS map in GrokApp) are frozen;
// only these display strings carry the theme, so renaming a room is one line.

export type RoomId =
  | 'integrations'
  | 'content'
  | 'hall'
  | 'dashboard'
  | 'council'
  | 'tidings'
  | 'calendar'
  | 'hearth'
  | 'library'
  | 'workspace'
  | 'pins'
  | 'reckoning'
  | 'forge'
  | 'weavings'
  | 'annals'
  | 'scribe';

export type RoomName = {
  /** Short label for nav rows and chips. */
  name: string;
  /** The sign above the room title. */
  eyebrow: string;
  /** One-line role, used where a room is described rather than named. */
  tagline: string;
};

export const ROOM_NAMES: Record<RoomId, RoomName> = {
  integrations: { name: 'Integrations', eyebrow: 'Your office', tagline: 'Connections and approvals' },
  content: { name: 'Content', eyebrow: 'Content Studio', tagline: 'Create, review, and publish' },
  hall: { name: 'Console Room', eyebrow: 'Console Room', tagline: 'Live with TARDIS' },
  dashboard: { name: 'Scanner', eyebrow: 'Scanner', tagline: 'Today at a glance' },
  council: { name: 'Missions', eyebrow: 'Missions', tagline: 'Task board' },
  tidings: { name: 'Transmissions', eyebrow: 'Transmissions', tagline: 'Unified email inbox' },
  calendar: { name: 'Timeline', eyebrow: 'Timeline', tagline: 'Connected schedules' },
  hearth: { name: 'Gallifrey', eyebrow: 'Gallifrey', tagline: 'Family and home' },
  library: { name: 'Library', eyebrow: 'The Library', tagline: 'Docs and references' },
  workspace: { name: 'Workshop', eyebrow: 'Workshop', tagline: "Edit the ship's files" },
  pins: { name: 'Fixed Points', eyebrow: 'Fixed Points', tagline: 'Quick notes' },
  reckoning: { name: 'Vault', eyebrow: 'The Vault', tagline: 'P&L tracker' },
  forge: { name: 'Engine Room', eyebrow: 'Engine Room', tagline: 'Cron and deploy log' },
  weavings: { name: 'UNIT', eyebrow: 'UNIT', tagline: 'Employee queue' },
  annals: { name: 'Archives', eyebrow: 'The Archives', tagline: 'Past sessions' },
  scribe: { name: 'Circuits', eyebrow: 'Circuits', tagline: 'Live activity log' },
};
