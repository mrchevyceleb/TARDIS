// ESM evaluation order guarantees this module's body runs before channels.ts
// evaluates its module-level JsonStore instances, so the unread tests get an
// isolated state dir instead of the live ~/.rivendell one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RIVENDELL_STATE_DIR = mkdtempSync(join(tmpdir(), `channels-unread-${process.pid}-`));
