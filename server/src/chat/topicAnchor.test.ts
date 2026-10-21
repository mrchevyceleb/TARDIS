import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTopicAnchor, getTopicAnchor, topicAnchorContext, clearTopicAnchor } from './topicAnchor.ts';

describe('topicAnchor', () => {
  beforeEach(() => clearTopicAnchor('t1'));

  it('stores a topic set by the thread owner', () => {
    const a = setTopicAnchor('t1', 'admin panel', 'matt', 'matt', 1000);
    assert.equal(a?.topic, 'admin panel');
    assert.equal(getTopicAnchor('t1')?.setAt, 1000);
  });

  it('ignores a topic set by anyone else', () => {
    setTopicAnchor('t1', 'admin panel', 'matt', 'matt', 1000);
    const a = setTopicAnchor('t1', 'referrals page', 'max-bg', 'matt', 2000);
    assert.equal(a?.topic, 'admin panel');
    assert.equal(getTopicAnchor('t1')?.topic, 'admin panel');
  });

  it('replaces the topic only when the owner sets a new one', () => {
    setTopicAnchor('t1', 'admin panel', 'matt', 'matt', 1000);
    setTopicAnchor('t1', 'billing page', 'matt', 'matt', 3000);
    assert.equal(getTopicAnchor('t1')?.topic, 'billing page');
  });

  it('rejects empty topics and unknown threads read as null', () => {
    assert.equal(setTopicAnchor('t1', '  ', 'matt', 'matt'), null);
    assert.equal(getTopicAnchor('nope'), null);
    assert.equal(topicAnchorContext('nope'), null);
  });

  it('renders the context line a lane sees', () => {
    setTopicAnchor('t1', 'admin panel', 'matt', 'matt');
    assert.ok(topicAnchorContext('t1')?.includes('admin panel'));
  });
});
