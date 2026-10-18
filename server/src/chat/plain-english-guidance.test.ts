// The plain-English block's gating (card-0d1015, review 1): which lanes and
// which turns carry it. agy is Gemini-direct; the OpenRouter lane's Gemini
// models carry it (including ~-prefixed alias ids); voice turns keep their
// own spoken-style addendum; automation, peer and continuation traffic must
// stay silent or exact, so no writing rule rides them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAIN_ENGLISH_WRITING_BLOCK, plainEnglishWritingBlockFor } from './plain-english-guidance.ts';

test('the block rides agy and OpenRouter Gemini human turns only', () => {
  assert.equal(plainEnglishWritingBlockFor({ cli: 'agy', model: '' }), PLAIN_ENGLISH_WRITING_BLOCK);
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'google/gemini-4-argon' }), PLAIN_ENGLISH_WRITING_BLOCK);
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: '~google/gemini-3.8-flash' }), PLAIN_ENGLISH_WRITING_BLOCK);
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'Google/Gemini-4-Argon' }), PLAIN_ENGLISH_WRITING_BLOCK);
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'anthropic/claude-opus-5.5' }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'zai', model: 'glm-5.3' }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'xai', model: 'grok-4.7' }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'fireworks', model: 'anything' }), '');
});

test('voice and non-human turns carry no block', () => {
  assert.equal(plainEnglishWritingBlockFor({ cli: 'agy', model: '', voiceMode: true }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'google/gemini-4-argon', voiceMode: true }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'agy', model: '', humanTurn: false }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'google/gemini-4-argon', humanTurn: false }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'google/gemini-4-argon', voiceMode: true, humanTurn: false }), '');
  assert.equal(plainEnglishWritingBlockFor({ cli: 'openrouter', model: 'google/gemini-4-argon', humanTurn: true }), PLAIN_ENGLISH_WRITING_BLOCK);
});
