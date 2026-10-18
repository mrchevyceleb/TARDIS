import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReplyQuote,
  normalizeReplyTo,
  withReplyQuote,
} from "./reply-quote.ts";

test("normalizeReplyTo accepts only a well-formed target and clamps it", () => {
  assert.deepEqual(normalizeReplyTo({ from: " Kip ", snippet: "  here is\nthe plan  " }), {
    from: "Kip",
    snippet: "here is the plan",
  });
  assert.equal(normalizeReplyTo(null), null);
  assert.equal(normalizeReplyTo("junk"), null);
  assert.equal(normalizeReplyTo({ from: 3, snippet: "x" }), null);
  // A junk snippet keeps the target: the from alone renders an honest
  // quoteless reply header ("Replying to Kip").
  assert.deepEqual(normalizeReplyTo({ from: "Kip", snippet: 42 }), { from: "Kip", snippet: "" });
  assert.equal(normalizeReplyTo({}), null);
  const long = normalizeReplyTo({ from: "K".repeat(200), snippet: "x".repeat(1000) });
  assert.equal(long?.from.length, 80);
  assert.equal(long?.snippet.length, 400);
});

test("a snippet that would split a surrogate pair is clipped by code point", () => {
  // 399 chars, then an emoji straddling the 400 boundary in UTF-16 units.
  const filler = "a".repeat(399);
  const snippet = filler + "🙂" + "b".repeat(10);
  const ref = normalizeReplyTo({ from: "Kip", snippet });
  assert.ok(ref !== null);
  assert.ok(ref.snippet.length <= 401); // code-point-clamped, not UTF-16-clamped
  assert.ok(Array.from(ref.snippet).length <= 400);
  assert.ok(!/[\uD800-\uDBFF]$/.test(ref.snippet)); // never a trailing lone surrogate
});

test("formatReplyQuote renders the block the agent sees", () => {
  assert.equal(formatReplyQuote(null), "");
  assert.equal(formatReplyQuote({ from: "Kip", snippet: "ship it" }), 'Replying to Kip:\n"ship it"\n\n');
  assert.equal(formatReplyQuote({ from: "Kip", snippet: "" }), "Replying to Kip\n\n");
});

test("withReplyQuote keeps a slash command's head and puts the quote after it", () => {
  const quote = formatReplyQuote({ from: "Kip", snippet: "ship it" });
  assert.equal(withReplyQuote("plain words", { from: "Kip", snippet: "ship it" }), `${quote}plain words`);
  assert.equal(withReplyQuote("/model sonnet", { from: "Kip", snippet: "ship it" }), `/model sonnet\n\n${quote.trimEnd()}`);
  assert.equal(withReplyQuote("plain words", null), "plain words");
});
