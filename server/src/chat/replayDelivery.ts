// History is transcript data, not a command to close/restart the current
// transport. In particular, -1 means no replay; clamping it to zero replays
// every historical close/error while admitting a new user message.
export function subscriptionReplayCursor(requested: number, repairedThrough: number): number {
  return requested < 0 ? -1 : Math.max(requested, repairedThrough);
}

export function historicalDelivery<T extends { seq: number; ev: unknown }>(frame: T): T | null {
  const event = frame.ev as Record<string, any> | null;
  if (!event || typeof event !== 'object') return frame;
  if (['closed', 'turnStart', 'turnEnd'].includes(event.type)) return null;
  if (event.type !== 'error') return frame;
  // Claude-family failures already have a durable _terminal_error event.
  // Older Banana turns stored only a transport error; retain that as a
  // transcript notice without rejecting the current outbound message.
  if (typeof event.code === 'string' && event.code.startsWith('BANANA_') && typeof event.message === 'string') {
    return { ...frame, ev: { type: 'event', event: {
      type: '_terminal_error', message: event.message, code: event.code, retryable: event.retryable === true,
    } } };
  }
  return null;
}
