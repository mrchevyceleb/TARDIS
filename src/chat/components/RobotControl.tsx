import { useEffect, useRef, useState } from 'react';
import { Bot, Square } from 'lucide-react';
import { fetchRobotEvents, fetchRobots, robotCommand, type LinkedRobot, type RobotEvent } from '../../data/api';
import './robot-control.css';

// Presence panel for a linked robot body. Renders nothing while no robot is
// online, so threads without one pay no space for it. Agents drive the robot
// through the robot_* tools; this panel is the human's quick hand on it.

const QUICK_EXPRESSIONS = ['HAPPY', 'THINK', 'PUZZLED', 'EXCITED', 'CAUTIOUS', 'SLEEPY', 'LOOK LEFT', 'LOOK RIGHT', 'HEARTS', 'SHOCKED'];

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Robot unavailable.';
  try { return JSON.parse(text).error ?? text; } catch { return text; }
}

function describeEvent(event: RobotEvent): string {
  const detail = Object.entries(event.data).slice(0, 3).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
  return `${event.name.replace(/_/g, ' ')}${detail ? ` · ${detail}` : ''}`;
}

export function RobotControl() {
  const [robots, setRobots] = useState<LinkedRobot[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<RobotEvent[]>([]);
  const [text, setText] = useState('');
  const [expression, setExpression] = useState('HAPPY');
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const selectedRef = useRef('');
  selectedRef.current = selected;

  useEffect(() => {
    alive.current = true;
    const ac = new AbortController();
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await fetchRobots(ac.signal);
        if (ac.signal.aborted) return;
        setRobots(data.robots);
        setError('');
        const target = data.robots.find((r) => r.id === selectedRef.current) ?? data.robots[0];
        if (target) {
          const recent = await fetchRobotEvents({ robot: target.id, limit: 4 }, ac.signal);
          // The selection may have moved while this request was in flight;
          // never paint one robot's events under another robot's name.
          const stillCurrent = (data.robots.find((r) => r.id === selectedRef.current) ?? data.robots[0])?.id === target.id;
          if (!ac.signal.aborted && stillCurrent) setEvents(recent.events.slice().reverse());
        } else setEvents([]);
      } catch (e) { if (!ac.signal.aborted) setError(errorText(e)); }
      finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { alive.current = false; ac.abort(); clearInterval(timer); };
  }, []);

  if (!robots.length) return null;
  const robot = robots.find((r) => r.id === selected) ?? robots[0];
  const status = robot.robot;
  const battery = status?.battery !== undefined ? `${status.battery}%${status.charging ? ' ⚡' : ''}` : '';
  const voice = status?.voice && status.voice !== 'off' ? status.voice : '';

  /** Runs one command; resolves true only when the robot accepted it. */
  const run = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true); setError(''); setNotice('');
    try { await action(); if (alive.current) setNotice(label); return true; }
    catch (e) { if (alive.current) setError(errorText(e)); return false; }
    finally { if (alive.current) setPending(false); }
  };

  // Stop is independent of every other request: a long say must never make
  // the emergency button wait.
  const stop = async () => {
    setStopping(true); setError('');
    try { await robotCommand(robot.id, 'stop'); if (alive.current) setNotice('Stopped.'); }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setStopping(false); }
  };

  return <details className="robot-control">
    <summary>
      <Bot size={14} aria-hidden="true" />
      <span>Robot · {robot.name}{battery ? ` · ${battery}` : ''}</span>
      {(voice || status?.moving) && <strong>{status?.moving ? 'Moving' : voice === 'speaking' ? 'Speaking' : voice === 'listening' ? 'Listening' : voice === 'thinking' ? 'Thinking' : 'On call'}</strong>}
    </summary>
    <div className="robot-control-body">
      {robots.length > 1 && <label>Robot
        <select aria-label="Robot" value={robot.id} disabled={pending} onChange={(event) => { setSelected(event.target.value); setEvents([]); }}>
          {robots.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>}
      <p>
        {status?.hardware === 'mock' ? 'Simulated body (mock hardware). ' : ''}
        {status?.expression ? `Last expression ${status.expression.toLowerCase()}. ` : ''}
        {status?.errors?.length ? `Hardware: ${status.errors.join('; ')}. ` : ''}
        {!status?.expression && !status?.errors?.length ? 'Linked and idle. Companions can see, speak and move through it.' : ''}
      </p>
      <div className="robot-control-row">
        <select aria-label="Expression" value={expression} disabled={pending} onChange={(event) => setExpression(event.target.value)}>
          {QUICK_EXPRESSIONS.map((name) => <option key={name} value={name}>{name.toLowerCase()}</option>)}
        </select>
        <button type="button" disabled={pending} onClick={() => void run(`Played ${expression.toLowerCase()}.`, () => robotCommand(robot.id, 'express', { expression }))}>Express</button>
      </div>
      <form className="robot-control-row" onSubmit={(event) => {
        event.preventDefault();
        const spoken = text.trim();
        if (!spoken || pending) return;
        void run('Spoken.', () => robotCommand(robot.id, 'say', { text: spoken })).then((ok) => { if (ok && alive.current) setText(''); });
      }}>
        <input aria-label="Say aloud on the robot" placeholder="Say aloud…" maxLength={600} value={text} disabled={pending} onChange={(event) => setText(event.target.value)} />
        <button type="submit" disabled={pending || !text.trim()}>Say</button>
      </form>
      <div className="robot-control-actions">
        <button type="button" className="robot-stop" disabled={stopping} onClick={() => void stop()}><Square size={12} aria-hidden="true" /> Stop motion</button>
      </div>
      {notice && <p className="robot-control-notice">{notice}</p>}
      {error && <p role="alert" className="robot-control-error">{error}</p>}
      {events.length > 0 && <ul className="robot-control-events" aria-label={`Recent events from ${robot.name}`}>
        {events.map((event) => <li key={event.seq}><time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{robots.length > 1 ? ` ${event.robotName} · ` : ' '}{describeEvent(event)}</li>)}
      </ul>}
    </div>
  </details>;
}
