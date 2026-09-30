// A finished background job in the thread. The server delivers the result as an
// "automation" peer message (job_start result or watch_job wake); this turns it
// into a compact status card so it never reads as a person talking: no avatar,
// a status glyph and chip, the duration, and the last output in monospace.
// One line by default; a failed job starts open.

import { useId, useState } from 'react';
import type { ChatBlock } from '../../data/types';
import { ChevronDown } from '../reimagine/icons';
import { fmtTime, parseJobResult } from './format';
import { JobRing } from './parts';
import './jobs.css';

export function JobResultCard({ block }: { block: Extract<ChatBlock, { kind: 'peer' }> }) {
  const result = parseJobResult(block.text, block.from);
  const expandable = result.output.length > 0;
  const [open, setOpen] = useState(result.tone === 'bad' && expandable);
  const bodyId = useId();
  const glyphTone = result.tone === 'run' ? 'note' : result.tone;
  const when = !block.tsApprox ? fmtTime(block.ts) : '';

  const head = (
    <>
      <JobRing tone={glyphTone} small />
      <span className="jr-kicker">job</span>
      <span className="jr-title">{result.name}</span>
      <span className="jr-chip">{result.label}</span>
      {result.duration ? <span className="jr-dur">{result.duration}</span> : null}
      {!open && result.peek ? <span className="jr-peek">{result.peek}</span> : <span className="jr-fill" />}
      {when ? <span className="jr-when">{when}</span> : null}
      {expandable ? <ChevronDown className="jr-chev" aria-hidden="true" /> : null}
    </>
  );

  return (
    <div className={`jr-card jt-${result.tone}${open ? ' is-open' : ''}`} data-job-result={result.label}>
      {expandable ? (
        <button
          type="button"
          className="jr-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
        </button>
      ) : (
        <div className="jr-head is-static">{head}</div>
      )}
      {open && expandable ? <pre className="jr-log" id={bodyId} tabIndex={0}>{result.output}</pre> : null}
    </div>
  );
}
