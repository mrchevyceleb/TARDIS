// Small shared pieces of the jobs UI.

/** A ring with a moving arc while a job runs, a check or bang once it ended. */
export function JobRing({ tone, small = false, stopping = false }: {
  tone: 'run' | 'ok' | 'bad' | 'warn' | 'note';
  small?: boolean;
  stopping?: boolean;
}) {
  const cls = `jb-ring${tone === 'run' ? ' is-run' : ''}${small ? ' is-small' : ''}${stopping ? ' is-stopping' : ''}`;
  if (tone === 'run') {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="20 18" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.6" />
      {tone === 'ok'
        ? <path d="M5.2 8.3l2 2 3.6-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        : tone === 'note'
          ? <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          : <path d="M8 4.8v3.6M8 10.9v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}
