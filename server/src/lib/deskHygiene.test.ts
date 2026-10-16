// Root-cause proof for the 2026-10-16 "busy 48 minutes with no card" false
// alarm on a lane that only ran short check turns: minute tallies credit each
// turn's own wall-clock age — its full span, once it proves sustained — so a day of 30-second prechecks — even chained
// back to back, even across lanes — accrues zero minutes and never trips the
// no-card nudge, while one genuinely long turn accrues on every tick past the
// two-minute threshold and a sustained uncalled day still warns.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './desk-hygiene-env.ts';
import { runDeskHygieneTick, type HygieneAgent, type HygieneDeps } from './deskHygiene.ts';

const KATE: HygieneAgent = { id: 'kate', name: 'Kate', home: 'kate' };
// Fri Oct 16 2026 09:00 ET (EDT = UTC-4): past the 08:00 slot so seed marks it
// fired, and before the 10:00 slot the nudge cases need.
const BASE_MS = Date.UTC(2026, 9, 16, 13, 0, 0);

type TickOpts = { jumpToMs?: number; turnStartMs?: number | null };

function harness(startMs: number = BASE_MS) {
  let nowMs = startMs;
  let turnStartMs: number | null = null; // null: no turn-start stamps (fallback path)
  const sent: { to: string; text: string }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'desk-hygiene-'));
  const base: HygieneDeps = {
    now: () => nowMs,
    readDesk: async () => ({ version: 1 as const, rev: 0, todos: [], cards: [] }),
    listAgents: () => [KATE],
    liveAgentIds: () => new Set<string>(),
    deliver: async (message) => { sent.push(message); return { delivered: true }; },
    log: () => {},
    ownerName: 'Matt',
    dryRun: false,
    stateFile: join(dir, 'hygiene.json'),
  };
  const tick = (live: boolean, opts: TickOpts = {}) => {
    if (opts.jumpToMs !== undefined) nowMs = opts.jumpToMs;
    if (opts.turnStartMs !== undefined) turnStartMs = opts.turnStartMs;
    const deps: Partial<HygieneDeps> = { liveAgentIds: () => new Set(live ? [KATE.id] : []) };
    if (turnStartMs !== null) {
      const start = turnStartMs;
      deps.liveTurnStarts = () => new Map([[KATE.id, start]]);
    }
    const result = runDeskHygieneTick({ ...base, ...deps });
    nowMs += 60_000;
    return result;
  };
  const state = () => JSON.parse(readFileSync(base.stateFile, 'utf8')) as {
    minutes: Record<string, number>;
    streak: Record<string, number>;
  };
  return { tick, sent, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The env module's temp state dir (see desk-hygiene-env.ts) outlives the
// harness dirs; remove it once the whole file is done.
after(() => {
  const dir = process.env.RIVENDELL_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('an hour of chained 30-second check turns accrues zero minutes and never nudges', async () => {
  const { tick, sent, state, cleanup } = harness();
  try {
    // 09:00-09:59: every minute tick is live, but each tick's turn started
    // only 30 seconds ago — a fresh short turn each time, back to back.
    for (let i = 0; i < 60; i++) {
      await tick(true, { turnStartMs: BASE_MS + i * 60_000 - 30_000 });
    }
    assert.equal(state().minutes.kate, undefined);
    // 10:00 slot sweep over a check-only day: no finding, no message.
    await tick(true, { turnStartMs: BASE_MS + 60 * 60_000 - 30_000 });
    assert.equal(sent.length, 0);
    assert.equal(state().minutes.kate, undefined);
  } finally {
    cleanup();
  }
});

test('a long turn accrues on every tick past the two-minute threshold', async () => {
  const { tick, state, cleanup } = harness();
  try {
    const turnStart = BASE_MS;
    await tick(true, { turnStartMs: turnStart }); // age 0: no credit
    assert.equal(state().minutes.kate, undefined);
    await tick(true, { turnStartMs: turnStart }); // age 1m: still buffered
    assert.equal(state().minutes.kate, undefined);
    await tick(true, { turnStartMs: turnStart }); // age 2m: whole span credited at once
    assert.equal(state().minutes.kate, 2);
    await tick(true, { turnStartMs: turnStart }); // age 3m: one per further tick
    assert.equal(state().minutes.kate, 3);
    await tick(true, { turnStartMs: turnStart }); // age 4m
    assert.equal(state().minutes.kate, 4);
  } finally {
    cleanup();
  }
});

test('sustained work split across many turns is not undercounted', async () => {
  // Channels restart turns at tool boundaries and queued messages, so a long
  // stretch of real card-less work often lands as several medium turns. Each
  // turn keeps its own crossing credit, so 48 real minutes split into twelve
  // 4-minute turns still tally 48, not 24, and still trips the 30-minute nudge.
  const { tick, sent, state, cleanup } = harness();
  try {
    for (let turn = 0; turn < 12; turn++) {
      const turnStart = BASE_MS + turn * 5 * 60_000;
      for (let i = 0; i < 5; i++) {
        await tick(true, { jumpToMs: turnStart + i * 60_000, turnStartMs: turnStart });
      }
    }
    assert.equal(state().minutes.kate, 48);
    // 10:00 slot sweep: 48 minutes with no In progress card must still warn.
    await tick(true, { turnStartMs: BASE_MS + 58 * 60_000, jumpToMs: BASE_MS + 60 * 60_000 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /no In progress card/);
  } finally {
    cleanup();
  }
});

test('a sustained day with no In progress card still trips the no-card nudge', async () => {
  const start = Date.UTC(2026, 9, 16, 13, 20, 0); // 09:20 ET
  const { tick, sent, cleanup } = harness(start);
  try {
    const turnStart = start; // one turn from 09:20 through the sweep
    for (let i = 0; i < 31; i++) await tick(true, { turnStartMs: turnStart }); // through 09:51
    // Jump to the 10:00 sweep; the same turn is still running.
    await tick(true, { turnStartMs: turnStart, jumpToMs: Date.UTC(2026, 9, 16, 14, 0, 0) });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /no In progress card/);
    assert.match(sent[0].text, /live turns for \d+ minutes today/);
  } finally {
    cleanup();
  }
});

test('overlapping home and background turns never double-credit the same minutes', async () => {
  // The live map reports an agent's OLDEST live turn start; when the home
  // turn ends first, the start jumps to the still-live bg turn's start. The
  // credited-through watermark must keep that jump from re-crediting the
  // minutes the home turn already paid for (review 3 P0: 17.5 real minutes
  // tallied 32).
  const { tick, state, cleanup } = harness();
  try {
    const home = BASE_MS; // 09:00 ET
    const bg = BASE_MS + 60_000; // 09:01 ET
    for (let i = 0; i <= 16; i++) {
      await tick(true, { jumpToMs: home + i * 60_000, turnStartMs: home });
    }
    assert.equal(state().minutes.kate, 16);
    // 09:17: home ended at 09:16:30; the map now reports the bg turn (09:01).
    await tick(true, { jumpToMs: home + 17 * 60_000, turnStartMs: bg });
    assert.equal(state().minutes.kate, 17);
  } finally {
    cleanup();
  }
});

test('a turn dormant across midnight earns its opening, not the dormant hours', async () => {
  // A turn opens at 21:59 ET, is seen once at 22:00, then the host sleeps
  // with the turn still open: the first tick after wake must not pour the
  // unseen night into the fresh day's tally.
  const night = Date.UTC(2026, 9, 17, 1, 59); // 21:59 ET Oct 16
  const wake = Date.UTC(2026, 9, 17, 11, 0); // 07:00 ET Oct 17
  const { tick, state, cleanup } = harness(night);
  try {
    await tick(true, { jumpToMs: night + 60_000, turnStartMs: night }); // 22:00: age 1m, buffered
    assert.equal(state().minutes.kate, undefined);
    await tick(true, { jumpToMs: wake, turnStartMs: night }); // day rolled; age 9h
    assert.equal(state().minutes.kate, 2);
  } finally {
    cleanup();
  }
});

test('fallback (no turn-start stamps): a buffered tick streak still filters short turns', async () => {
  const { tick, state, cleanup } = harness();
  try {
    await tick(true); // streak 1: buffered, not yet tallied
    assert.equal(state().minutes.kate, undefined);
    await tick(true); // streak 2: turn proved sustained, both minutes credited
    assert.equal(state().minutes.kate, 2);
    await tick(false); // gap: streak resets
    await tick(true); // a fresh short turn contributes nothing
    assert.equal(state().minutes.kate, 2);
  } finally {
    cleanup();
  }
});
