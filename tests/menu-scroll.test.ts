import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { menuClosesOnScroll } from '../src/grok/menuScroll.ts';

// Only DOM ancestry is needed here. Keep these unit tests dependency-free;
// interaction, layout, and color persistence belong to the browser gate.
class DomNode extends EventTarget {
  constructor(public parent: DomNode | null = null) { super(); }
  get isConnected(): boolean { return this instanceof DomDocument || !!this.parent?.isConnected; }
  contains(other: DomNode): boolean {
    for (let node: DomNode | null = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }
}
class DomElement extends DomNode {}
class DomDocument extends DomNode {}

const globals = ['Node', 'Element'] as const;
const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
before(() => {
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: DomNode });
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: DomElement });
});
after(() => {
  globals.forEach((name, index) => {
    const descriptor = previous[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

function fixture() {
  const document = new DomDocument();
  const app = new DomElement(document);
  const rail = new DomElement(app);
  const row = new DomElement(rail);
  const anchor = new DomElement(row);
  const feed = new DomElement(app);
  const menu = new DomElement(app); // Portaled beside the rail, not inside it.
  const menuList = new DomElement(menu);
  const closes = (target: EventTarget | null, restore: DomElement | null = anchor) => menuClosesOnScroll(
    menu as unknown as HTMLElement,
    restore as unknown as HTMLElement | null,
    target,
  );
  return { document, app, rail, row, anchor, feed, menu, menuList, closes };
}

test('repeated feed autoscroll and unrelated rail descendants keep a menu open', () => {
  const { feed, rail, closes } = fixture();
  for (let frame = 0; frame < 10; frame++) assert.equal(closes(feed), false);
  assert.equal(closes(new DomElement(rail)), false);
});

test('scrolling the anchor or any of its ancestors dismisses a fixed menu', () => {
  const { app, rail, row, anchor, closes } = fixture();
  for (const target of [anchor, row, rail, app]) assert.equal(closes(target), true);
});

test('document and unknown viewport targets still dismiss a menu', () => {
  const { document, closes } = fixture();
  assert.equal(closes(document), true);
  assert.equal(closes(new EventTarget()), true);
  assert.equal(closes(null), true);
});

test('scrolling the popup or a nested menu list does not dismiss it', () => {
  const { menu, menuList, closes } = fixture();
  assert.equal(closes(menu), false);
  assert.equal(closes(menuList), false);
});

test('a missing or detached anchor cannot leave a stale menu on background scroll', () => {
  const { feed, anchor, closes } = fixture();
  assert.equal(closes(feed, null), true);
  anchor.parent = null;
  assert.equal(closes(feed), true);
});
