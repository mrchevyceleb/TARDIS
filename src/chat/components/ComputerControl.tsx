import { useEffect, useRef, useState } from 'react';
import { Monitor, Square } from 'lucide-react';
import { fetchComputers, previewComputer, selectComputer, stopComputer, type ComputerPreview, type LinkedComputer } from '../../data/api';
import { nativeShell } from '../../native/shell';
import './computer-control.css';

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Computer unavailable.';
  try { return JSON.parse(text).error ?? text; } catch { return text; }
}
export function ComputerControl({ chatId }: { chatId: string }) {
  const [devices, setDevices] = useState<LinkedComputer[]>([]);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const revision = useRef(0);
  const device = devices.find(d => d.id === selected);
  const control = device?.computer?.control;
  const localId = nativeShell()?.deviceId;
  const previewOwner = useRef('');
  previewOwner.current = `${selected}:${control?.owner ?? ''}:${control?.expiresAt ?? ''}`;

  useEffect(() => {
    const ac = new AbortController();
    revision.current++;
    setSelected(''); setDevices([]); setPreview(null); setError('');
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      const rev = revision.current;
      try {
        const data = await fetchComputers(chatId, ac.signal);
        if (ac.signal.aborted) return;
        if (revision.current === rev) { setDevices(data.devices); setSelected(data.target); }
      } catch (e) { if (!ac.signal.aborted) setError(errorText(e)); }
      finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { ac.abort(); clearInterval(timer); revision.current++; };
  }, [chatId]);
  useEffect(() => { setPreview(null); }, [selected, control?.owner, control?.expiresAt]);

  const stop = async () => {
    if (!selected) return;
    const rev = ++revision.current;
    setPending(true); setError('');
    try {
      await stopComputer(selected);
      setPreview(null);
      setDevices(current => current.map(d => d.id === selected && d.computer ? { ...d, computer: { ...d.computer, control: null } } : d));
    } catch (e) { setError(errorText(e)); }
    finally { if (revision.current === rev) { revision.current++; setPending(false); } }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (control && (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && event.key === 'Escape') {
        event.preventDefault(); void stop();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return <details className="computer-control">
    <summary><Monitor size={14} aria-hidden="true" /><span>Computer · {device ? (device.id === localId ? `This computer (${device.name})` : device.name) : selected ? 'Offline' : 'Not selected'}</span>{control && <strong>In use</strong>}</summary>
    <div className="computer-control-body">
      <label>Target computer
        <select aria-label="Target computer" value={selected} disabled={pending} onChange={async event => {
          const target = event.target.value;
          const rev = ++revision.current;
          setPending(true); setError('');
          try { await selectComputer(chatId, target); if (rev === revision.current) { setSelected(target); setPreview(null); } }
          catch (e) { if (rev === revision.current) setError(errorText(e)); }
          finally { if (rev === revision.current) { revision.current++; setPending(false); } }
        }}>
          <option value="">Choose a computer</option>
          {selected && !device && <option value={selected}>Selected computer is offline</option>}
          {devices.map(d => <option key={d.id} value={d.id}>{d.id === localId ? `This computer · ${d.name}` : d.name}{!d.computer?.supported ? ' · unavailable' : ''}</option>)}
        </select>
      </label>
      <p>{control ? `${control.label} is controlling this desktop until ${new Date(control.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : device?.computer?.reason || (device ? 'Ask your agent to use this computer. Control requires approval on that machine.' : 'Open the Electron app on your computer, or start the host desktop companion. No target switches automatically.')}</p>
      {control && <div className="computer-control-actions">
        <button type="button" className="computer-stop" disabled={pending} onClick={() => void stop()}><Square size={12} aria-hidden="true" /> Stop control</button>
        <button type="button" disabled={pending} onClick={async () => {
          const rev = revision.current;
          const owner = previewOwner.current;
          setError('');
          try { const next = await previewComputer(selected); if (revision.current === rev && previewOwner.current === owner) setPreview(next); }
          catch (e) { if (revision.current === rev) setError(errorText(e)); }
        }}>{preview ? 'Refresh preview' : 'Show last screenshot'}</button>
      </div>}
      {error && <p role="alert" className="computer-control-error">{error}</p>}
      {preview && control && <figure><img src={`data:image/jpeg;base64,${preview.image}`} alt={`Last agent screenshot of ${device?.name ?? 'computer'}`} /><figcaption>Last captured {new Date(preview.capturedAt).toLocaleTimeString()} · not a live feed <button type="button" onClick={() => setPreview(null)}>Hide</button></figcaption></figure>}
    </div>
  </details>;
}
