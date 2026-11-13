// A teammate's name always shows whole, in any room. Name boxes wrap at
// spaces, and where a single word is still wider than its box in the room's
// typeface (a wide pixel face in a small tile), its type steps down until the
// word fits. Names that already fit are never touched.
//
// Use as a ref: <span className="ts-name" ref={fitName}>{name}</span>

const names = new Set<HTMLElement>();
let observer: ResizeObserver | null = null;
let renames: MutationObserver | null = null;
let frame = 0;

function fitAll() {
  frame = 0;
  const list = [...names];
  // Clear, then read everything, then write: one layout pass, no thrash.
  for (const el of list) el.style.fontSize = '';
  const reads = list.map((el) => ({
    el,
    over: el.clientWidth ? el.scrollWidth / el.clientWidth : 1,
    size: parseFloat(getComputedStyle(el).fontSize),
  }));
  for (const { el, over, size } of reads) {
    if (over > 1.005 && size) el.style.fontSize = `${Math.floor((size / over) * 20) / 20}px`;
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(fitAll);
}

function start() {
  observer = new ResizeObserver(schedule);
  // A rename changes the words without always resizing the box.
  renames = new MutationObserver(schedule);
  // A room change swaps the face without always resizing the box.
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-display', 'data-team', 'data-layout', 'style'],
  });
  document.fonts?.addEventListener('loadingdone', schedule);
}

export function fitName(el: HTMLElement | null) {
  if (!el) return;
  if (!observer) start();
  names.add(el);
  observer!.observe(el);
  renames!.observe(el, { characterData: true, childList: true, subtree: true });
  schedule();
  return () => {
    names.delete(el);
    observer?.unobserve(el);
  };
}
