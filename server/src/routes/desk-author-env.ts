// Imported FIRST by desk-author.test.ts. ESM hoists static imports, so the
// environment has to be set in its own module ahead of desk.ts, which loads
// config.ts and chat/agents.ts (and with them the live roster) at import
// time. This keeps the author tests on a temp state dir and a pinned owner
// name instead of ~/.rivendell.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RIVENDELL_STATE_DIR = mkdtempSync(join(tmpdir(), `desk-author-${process.pid}-`));
process.env.RIVENDELL_OWNER_NAME = 'Matt';
