// Reimagined MOBILE chat shell — §5 (the flagship). Header + chronicle ribbon
// + feed + composer dock, with Chronicle + Counsel bottom sheets, an attach
// menu, a toast, and tap-toggle timestamps/actions. The phone preview frame
// from the prototype is presentation only and is NOT ported — this goes
// full-bleed on real mobile. Rendered by Threshold under the mobile
// breakpoint. (No Hall/Council/Forge segmented tabs — they duplicated the
// Studio top bar's tabs + ⋯ menu and ate vertical space; the ⋯ menu's Council
// / Forge entries open the real Studio tabs. No Files room — the Studio
// sidebar owns file browsing; no theme button — the Studio top bar owns the
// toggle.)

import { useEffect, useRef, useState } from 'react';
import type { ShellViewProps } from '../reimagine/useChatShell';
import { ChatThread } from '../reimagine/blocks';
import { Composer, AttachButton } from '../reimagine/Composer';
import { CounselSheet, ModelChip } from '../reimagine/CounselPicker';
import {
  ChronicleRows,
  RibbonTicker,
} from '../reimagine/RoomViews';
import { Book, StarSigil, Camera, Edit, Folder, SquarePen } from '../reimagine/icons';
import { ROOM_NAMES } from '../../../data/roomNames';

type Sheet = 'none' | 'chronicle' | 'counsel';

export function Mobile({ s, picker, repo }: ShellViewProps) {
  const [sheet, setSheet] = useState<Sheet>('none');
  const [attachOpen, setAttachOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const openFileInput = useRef<() => void>(() => {});

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  // Clear any pending toast timer on unmount so it can't setState after teardown.
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  // Escape closes whichever sheet is open.
  useEffect(() => {
    if (sheet === 'none' && !attachOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet('none'), setAttachOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet, attachOpen]);

  const closeAll = () => {
    setSheet('none');
    setAttachOpen(false);
  };

  return (
    <div className="rc rc-mobile">
      <div className="app">
        <div className="sky" aria-hidden="true">
          {Array.from({ length: 26 }, (_, i) => (
            <span
              key={i}
              className="st"
              style={{
                left: `${(i * 37) % 100}%`,
                top: `${(i * 61) % 100}%`,
                width: 1.5,
                height: 1.5,
                ['--d' as string]: `${2 + ((i * 7) % 40) / 10}s`,
                ['--dl' as string]: `${(i * 13) % 50 / 10}s`,
              } as React.CSSProperties}
            />
          ))}
        </div>

        {/* header */}
        <header className="head">
          <button
            type="button"
            className="sigil"
            aria-label="TARDIS mark"
            onClick={(e) => s.sparks.burst(e.clientX, e.clientY)}
          >
            <StarSigil style={{ width: 17, height: 17 }} />
          </button>
          <div>
            <h1>{ROOM_NAMES.hall.name}</h1>
            <div className="presence">
              <span className="pulse" style={{ width: 6, height: 6 }} /> TARDIS online · {repo?.branch ?? 'master'}
            </div>
          </div>
          <button type="button" className="iconbtn" aria-label="Open the Chronicle" onClick={() => setSheet('chronicle')}>
            <Book />
          </button>
        </header>

        <RibbonTicker events={s.chronicle} />

        {/* feed */}
        <main className="feed" ref={s.sticky.scrollRef} onScroll={s.sticky.onScroll}>
          <ChatThread
            blocks={s.blocks}
            status={s.status}
            contentRef={s.sticky.contentRef}
            bottomRef={s.sticky.bottomRef}
            mobile
            suppressTyping={s.automationBusy}
            workingSince={s.workingSince}
          />
          {s.error ? (
            <div className="chip" style={{ color: 'var(--amber)', borderColor: 'color-mix(in oklch, var(--amber) 40%, transparent)', background: 'color-mix(in oklch, var(--amber) 10%, transparent)' }}>
              ⚠ {s.error}
            </div>
          ) : null}
        </main>

        {/* jump pill */}
        <button
          type="button"
          className={`jump${s.sticky.unread > 0 || (!s.sticky.pinned && s.busy) ? ' show' : ''}`}
          onClick={s.sticky.jumpToBottom}
        >
          To the latest word
          {s.sticky.unread > 0 ? <span className="cnt">{s.sticky.unread}</span> : null}
        </button>

        {/* composer dock */}
        <div className="dock">
            <Composer
              chatId={s.chatId}
              mobile
              value={s.value}
              onChange={s.setValue}
              onSend={s.send}
              onStop={s.stop}
              onSteer={s.steer}
              busy={s.busy}
              commands={s.commands}
              modelChip={<ModelChip picker={picker} onClick={() => setSheet('counsel')} />}
              attachButton={<AttachButton onClick={() => setAttachOpen((o) => !o)} />}
              attachMenu={
                attachOpen ? (
                  <div className="pop amenu show">
                    <button
                      type="button"
                      className="arow"
                      onClick={() => {
                        setAttachOpen(false);
                        openFileInput.current();
                      }}
                    >
                      <Camera /> A photograph
                    </button>
                    <button
                      type="button"
                      className="arow"
                      onClick={() => {
                        setAttachOpen(false);
                        s.setValue((v) => `${v} @`);
                      }}
                    >
                      <Folder /> From the Hub
                    </button>
                    <button
                      type="button"
                      className="arow"
                      onClick={() => {
                        setAttachOpen(false);
                        s.setRoom('hall');
                        s.fresh();
                        showToast('a fresh thread');
                      }}
                    >
                      <SquarePen /> A fresh thread
                    </button>
                    <button
                      type="button"
                      className="arow"
                      onClick={() => {
                        setAttachOpen(false);
                        s.setRoom('hall');
                        s.setValue('/weave ');
                      }}
                    >
                      <Edit /> Weave a note
                    </button>
                  </div>
                ) : null
              }
              openFileInputRef={openFileInput}
              onMellon={(rect) => s.sparks.burst(rect.left + rect.width / 2, rect.top + rect.height / 2)}
            />
          </div>

        {/* toast */}
        {toast ? <div className="toast show">{toast}</div> : null}

        {/* chronicle bottom sheet (own scrim) */}
        {sheet === 'chronicle' ? (
          <>
            <div className="scrim show" onClick={closeAll} />
            <div className="sheet show" role="dialog" aria-modal="true" aria-label="The Chronicle">
              <button type="button" className="sheet-grab" aria-label="Close" onClick={closeAll}>
                <i />
              </button>
              <h2>The Chronicle</h2>
              <div className="sheet-list">
                <ChronicleRows
                  events={s.chronicle}
                  onPick={(e) => {
                    s.pickChronicle(e);
                    closeAll();
                  }}
                />
              </div>
            </div>
          </>
        ) : null}
        <CounselSheet picker={picker} open={sheet === 'counsel'} onClose={closeAll} />
      </div>
      {s.sparks.sparks}
    </div>
  );
}
