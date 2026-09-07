// The provider has already consumed these tool results. Keep frame metadata
// in TARDIS history, not private screen pixels or megabytes of base64. Native
// CLI/provider session storage is outside this relay's retention policy.
export function redactComputerImages<T>(event: T): T {
  const visit = (value: any): any => {
    if (Array.isArray(value)) {
      const frame = value.some(v => v?.type === 'text' && typeof v.text === 'string' && v.text.includes('"displayId"') && v.text.includes('"capturedAt"'));
      return value.map(v => frame && v?.type === 'image' ? { type: 'text', text: '[Desktop screenshot omitted from TARDIS history; capture again for current pixels.]' } : visit(v));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
        key === 'image' && value.displayId && value.capturedAt ? '[screenshot omitted]' : visit(v)]));
    }
    if (typeof value === 'string' && value.includes('"displayId"') && value.includes('"capturedAt"') && value.includes('"image"')) {
      try { return JSON.stringify(visit(JSON.parse(value))); } catch { /* not serialized tool content */ }
    }
    return value;
  };
  return visit(event) as T;
}
