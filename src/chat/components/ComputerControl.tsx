import { useEffect, useRef, useState } from 'react';
import { Monitor, Square } from 'lucide-react';
import { fetchComputers, previewComputer, resumeComputer, selectComputer, stopComputer, type ComputerPreview, type DefaultComputer, type LinkedComputer } from '../../data/api';
import { nativeShell } from '../../native/shell';
import './computer-control.css';

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Computer unavailable.';
  try { return JSON.parse(text).error ?? text; } catch { return text; }
}
export function ComputerControl({ chatId }: { chatId: string }) {
  const [devices, setDevices] = useState<LinkedComputer[]>([]);
  const [defaultDevice, setDefault] = useState<DefaultComputer | null>(null);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const revision = useRef(0);
  const previewRequest = useRef(0);
  const target = selected || defaultDevice?.id || '';
  const device = devices.find(d => d.id === target);
  const control = device?.computer?.control;
  const paused = device?.computer?.paused;
  const automatic = Boolean(device?.computer?.supported && device.computer.approvalMode === 'automatic');
  const localId = nativeShell()?.deviceId;
  const previewOwner = useRef('');
  previewOwner.current = `${target}:${control?.owner ?? ''}:${control?.expiresAt ?? ''}`;
  const applyState = (data: Awaited<ReturnType<typeof fetchComputers>>) => {
    setDevices(data.devices); setSelected(data.target || ''); setDefault(data.defaultDevice ?? null);
  };

  useEffect(() => {
    const ac = new AbortController();
    revision.current++;
    setSelected(''); setDefault(null); setDevices([]); setPreview(null); setError('');
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      const rev = revision.current;
      try {
        const data = await fetchComputers(chatId, ac.signal);
        if (!ac.signal.aborted && revision.current === rev) applyState(data);
      } catch (e) { if (!ac.signal.aborted) setError(errorText(e)); }
      finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { ac.abort(); clearInterval(timer); revision.current++; previewRequest.current++; };
  }, [chatId]);
  useEffect(() => { setPreview(null); previewRequest.current++; }, [target, control?.owner, control?.expiresAt]);

  const controlAction = async (resume: boolean) => {
    if (!target) return;
    const rev = ++revision.current;
    previewRequest.current++;
    setPending(true); setError(''); setPreview(null);
    try {
      await (resume ? resumeComputer(target) : stopComputer(target));
      const data = await fetchComputers(chatId);
      if (revision.current === rev) applyState(data);
    } catch (e) { if (revision.current === rev) setError(errorText(e)); }
    finally { if (revision.current === rev) { revision.current++; setPending(false); } }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (control && (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && event.key === 'Escape') {
        event.preventDefault(); void controlAction(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const name = device ? (device.id === localId ? `This computer (${device.name})` : device.name)
    : target ? (selected ? 'Offline' : defaultDevice?.name) : 'Not configured';
  return <details className="computer-control">
    <summary><Monitor size={14} aria-hidden="true" /><span>Computer · {name}</span>{(control || automatic || paused) && <strong>{paused ? 'Paused' : control ? 'In use' : 'Automatic'}</strong>}</summary>
    <div className="computer-control-body">
      <label>Target computer
        <select aria-label="Target computer" value={selected} disabled={pending} onChange={async event => {
          const next = event.target.value;
          const rev = ++revision.current;
          previewRequest.current++;
          setPending(true); setError('');
          try { await selectComputer(chatId, next); if (rev === revision.current) { setSelected(next); setPreview(null); } }
          catch (e) { if (rev === revision.current) setError(errorText(e)); }
          finally { if (rev === revision.current) { revision.current++; setPending(false); } }
        }}>
          <option value="">{defaultDevice ? `Default · ${defaultDevice.name}` : 'No default configured'}</option>
          {selected && !device && <option value={selected}>Selected computer is offline</option>}
          {devices.map(d => <option key={d.id} value={d.id} disabled={!d.computer?.supported}>{d.id === localId ? `This computer · ${d.name}` : d.name}{!d.computer?.supported ? ' · unavailable' : ''}</option>)}
        </select>
      </label>
      <p>{paused ? 'You stopped autonomous control. Resume when you want agents to use this computer again.' : control ? `${control.label} is controlling this desktop until ${new Date(control.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : device?.computer?.reason || (automatic ? 'Agents can operate this desktop for assigned work without approval popups.' : device?.computer?.supported ? 'This computer is configured to ask for native approval.' : device ? 'This client does not support desktop control. Update the desktop app.' : 'The selected/default computer is offline. No other machine will be used automatically.')}</p>
      {paused && <button type="button" disabled={pending} onClick={() => void controlAction(true)}>Resume control</button>}
      {automatic && !paused && !control && <button type="button" className="computer-stop" disabled={pending} onClick={() => void controlAction(false)}><Square size={12} aria-hidden="true" /> Pause control</button>}
      {control && <div className="computer-control-actions">
        <button type="button" className="computer-stop" disabled={pending} onClick={() => void controlAction(false)}><Square size={12} aria-hidden="true" /> Stop control</button>
        <button type="button" disabled={pending} onClick={async () => {
          const request = ++previewRequest.current;
          const owner = previewOwner.current;
          setError('');
          try { const next = await previewComputer(target); if (previewRequest.current === request && previewOwner.current === owner) setPreview(next); }
          catch (e) { if (previewRequest.current === request) setError(errorText(e)); }
        }}>{preview ? 'Refresh preview' : 'Show last screenshot'}</button>
      </div>}
      {error && <p role="alert" className="computer-control-error">{error}</p>}
      {preview && control && <figure><img src={`data:image/jpeg;base64,${preview.image}`} alt={`Last agent screenshot of ${device?.name ?? 'computer'}`} /><figcaption>Last captured {new Date(preview.capturedAt).toLocaleTimeString()} · not a live feed <button type="button" onClick={() => { previewRequest.current++; setPreview(null); }}>Hide</button></figcaption></figure>}
    </div>
  </details>;
}
