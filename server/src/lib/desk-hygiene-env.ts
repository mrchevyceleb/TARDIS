// ESM evaluation order guarantees this module's body runs before deskHygiene.ts
// (and the flag-digest module it imports) evaluates. The dry-run flag is what
// keeps the tick's digest flush from delivering anything; the isolated state
// dir is the second safeguard behind it, so a test run can never touch the
// live ~/.rivendell files. Pinning these also stops inherited shell settings
// (RIVENDELL_DESK_HYGIENE=off, a SKIP list naming Kate, a different owner)
// from silently skipping or emptying the suite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RIVENDELL_STATE_DIR = mkdtempSync(join(tmpdir(), `desk-hygiene-${process.pid}-`));
process.env.RIVENDELL_DESK_HYGIENE_DRY_RUN = '1';
process.env.RIVENDELL_DESK_HYGIENE = 'on';
process.env.RIVENDELL_OWNER_NAME = 'Matt';
delete process.env.RIVENDELL_DESK_HYGIENE_SKIP;
