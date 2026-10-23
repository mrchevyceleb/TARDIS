/** Dismiss a fixed rail menu only when scrolling can move its anchor.
 *  Background feed autoscroll must not interrupt a menu action. Kept separate
 *  from the React shells so both menus use the same regression-tested rule. */
export function menuClosesOnScroll(menu: HTMLElement | null, anchor: HTMLElement | null, target: EventTarget | null): boolean {
  // Scrolling within the popup is interaction, not dismissal.
  if (menu && target instanceof Node && menu.contains(target)) return false;
  if (!anchor?.isConnected) return true;
  // Document/viewport scrolls can move every row; unknown targets fail closed.
  if (!(target instanceof Element)) return true;
  return target.contains(anchor);
}
