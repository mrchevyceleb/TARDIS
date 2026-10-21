// wellFormed: no engine transport may receive malformed UTF-16.
//
// A lone surrogate is an unpaired UTF-16 code unit, the artifact a slice that
// cuts between the halves of a surrogate pair leaves behind. It is not a
// cosmetic problem: codex app-server hard-rejects any JSONRPC message that
// carries one ("lone leading surrogate in hex escape"), so the turn never
// starts and every retry of the same text fails the same way (Quinn's wake,
// Oct 19: 64 phantom rows, zero deliveries), and Anthropic rejects the same
// malformation with a 400 (see reply-quote.ts). Prompts are assembled from
// captured output, teammate text and log tails, so every engine boundary
// runs its text through here first: an unpaired unit becomes U+FFFD instead
// of wedging the lane. Well-formed text passes through unchanged.
export function wellFormedText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      } else {
        out += '�';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '�';
    } else {
      out += value[i];
    }
  }
  return out;
}
