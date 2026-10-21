import assert from 'node:assert/strict';
import test from 'node:test';
import { wellFormedText } from './wellFormed.ts';

/** True when the string contains an unpaired UTF-16 surrogate unit. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

test('well-formed text passes through unchanged', () => {
  const plain = 'plain ascii, accents éüß, CJK 漢字, and a real emoji 📺 pair';
  assert.equal(wellFormedText(plain), plain);
  assert.equal(hasLoneSurrogate(plain), false);
});

test('a lone low surrogate from a tail slice becomes U+FFFD', () => {
  // Exactly what resultText's tail slice used to produce: the high half cut
  // off, the low half left behind (Quinn's wake, Oct 19 — codex app-server
  // rejected every attempt's JSONRPC message on this one unit).
  const sliced = '\uded2\nSell\n0\n📺\nShow';
  const fixed = wellFormedText(sliced);
  assert.equal(fixed, '�\nSell\n0\n📺\nShow');
  assert.equal(hasLoneSurrogate(fixed), false);
});

test('a lone high surrogate from a head slice becomes U+FFFD', () => {
  assert.equal(wellFormedText('job \ud83d'), 'job �');
});

test('surrogate pairs survive intact', () => {
  assert.equal(wellFormedText('🛒'), '🛒'); // 🛒 as a pair
  assert.equal(wellFormedText('a📺 b'), 'a📺 b'); // 📺
});

test('every unpaired unit in a mixed string is replaced, none left behind', () => {
  const messy = '📺 ok \uded2 \ud83d mid \udcfa end';
  const fixed = wellFormedText(messy);
  assert.equal(fixed, '📺 ok � � mid � end');
  assert.equal(hasLoneSurrogate(fixed), false);
});
