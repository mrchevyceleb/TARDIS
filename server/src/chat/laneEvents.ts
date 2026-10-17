// Server-pushed lane events (card-a77246): routes can push a live payload to
// every open lane socket without reaching into the WS closure. registerChat
// installs the pusher when the socket map exists and clears it on teardown;
// before boot or after teardown a push is a no-op, so a route never has to
// know whether the socket layer is up.
type LanePushAll = (payload: Record<string, unknown>) => void;

let pushAll: LanePushAll | null = null;

export function setLanePushAll(push: LanePushAll | null): void {
  pushAll = push;
}

/** Broadcast a checklist update to every open lane socket: the sidebar keeps
 *  the invoking agent's checklist current the moment its tool writes, with no
 *  polling. `remote: true` marks it a server push, never the viewer's own
 *  action. Clients that do not hold the owner's sidebar simply ignore it. */
export function broadcastChecklist(owner: string, checklist: unknown): void {
  pushAll?.({ type: 'checklist', owner, checklist, remote: true });
}
