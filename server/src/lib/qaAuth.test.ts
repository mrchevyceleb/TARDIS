import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RIVENDELL_QA_REPOS = 'acme/operly,acme/studio';
process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=edgar-board,martin=martin-board';
process.env.RIVENDELL_QA_AUTH_SECRET = 'test-only-secret-value';

const { qaSignInPath, verifyQaSignIn, createQaSession, qaSessionTester, clearQaSession, qaSessionCookie } =
  await import('./qaAuth.ts');

test('a signed link verifies once for its tester, then exchanges for a session', () => {
  const path = qaSignInPath('martin');
  assert.ok(path);
  const url = new URL(path, 'http://localhost');
  const data = url.searchParams.get('d')!;
  const signature = url.searchParams.get('s')!;
  assert.equal(verifyQaSignIn(data, signature), 'martin');
  // The same signed link can never mint a second session.
  assert.equal(verifyQaSignIn(data, signature), null);
  const nonce = createQaSession('martin');
  assert.equal(qaSessionTester(`rivendell_qa_session=${nonce}`), 'martin');
  assert.match(qaSessionCookie(nonce), /HttpOnly/);
  clearQaSession(`rivendell_qa_session=${nonce}`);
  assert.equal(qaSessionTester(`rivendell_qa_session=${nonce}`), null);
});

test('tampered, wrong-secret and expired links never verify', () => {
  const path = qaSignInPath('edgar', Date.now() - 20 * 60_000);
  assert.ok(path);
  const url = new URL(path, 'http://localhost');
  const data = url.searchParams.get('d')!;
  const signature = url.searchParams.get('s')!;
  assert.equal(verifyQaSignIn(data, signature), null);
  const fresh = qaSignInPath('edgar');
  assert.ok(fresh);
  const tampered = new URL(fresh, 'http://localhost');
  assert.equal(verifyQaSignIn(tampered.searchParams.get('d')!.replace('edgar', 'martin'), tampered.searchParams.get('s')!), null);
  assert.equal(verifyQaSignIn('', ''), null);
});

test('operator identity: bare loopback yes, proxied tester no, operator login yes', async () => {
  const { qaIsOperator } = await import('./qaAuth.ts');
  // A bare-loopback request with a trusted Host/Origin (the operator's own
  // browser) is the operator; the same socket without that trust is not,
  // which is what stops DNS rebinding from a hostile page.
  assert.equal(qaIsOperator({}, '127.0.0.1', undefined, true), true);
  assert.equal(qaIsOperator({}, '::ffff:127.0.0.1', undefined, true), true);
  assert.equal(qaIsOperator({}, '127.0.0.1', undefined, false), false);
  assert.equal(qaIsOperator({}, '127.0.0.1', undefined), false);
  assert.equal(qaIsOperator({}, '10.0.0.9', undefined, true), false);
  assert.equal(qaIsOperator({ tailscaleUser: 'edgar@example.ts.net' }, '127.0.0.1', 'matt@example.ts.net'), false);
  assert.equal(qaIsOperator({ tailscaleUser: 'matt@example.ts.net' }, '127.0.0.1', 'matt@example.ts.net'), true);
  assert.equal(qaIsOperator({ xForwardedFor: '100.64.0.2' }, '127.0.0.1', undefined, true), false);
  assert.equal(qaIsOperator({ tailscaleUser: 'matt@example.ts.net', xForwardedFor: '100.64.0.7' }, '127.0.0.1', 'matt@example.ts.net'), true);
  assert.equal(qaIsOperator({ tailscaleUser: 'edgar@example.ts.net', xForwardedFor: '100.64.0.7' }, '127.0.0.1', 'matt@example.ts.net'), false);
});

test('tester logins must be complete and unique', async () => {
  const { configuredTesterLogins, qaBoardEnabled, qaTesterByLogin } = await import('./qaBoard.ts');
  const saved = process.env.RIVENDELL_QA_TESTER_LOGINS;
  try {
    process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=sud-board,martin=martin-board';
    assert.equal(configuredTesterLogins(), undefined);
    assert.equal(qaBoardEnabled(), false);
    process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=edgar-board';
    assert.equal(configuredTesterLogins(), undefined);
    assert.equal(qaBoardEnabled(), false);
    process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=edgar-board,martin=martin-board';
    assert.ok(configuredTesterLogins());
    assert.equal(qaBoardEnabled(), true);
    assert.equal(qaTesterByLogin('edgar-board'), 'edgar');
  } finally {
    process.env.RIVENDELL_QA_TESTER_LOGINS = saved;
  }
});
