// Reimagined DESKTOP chat shell — §4. A single main column with a chronicle
// ribbon ticker, a 760px feed, and the composer dock. (The old 296px sidebar
// — new-errand, Chronicle pane, hubs, companion footer — was removed: the
// Studio top bar owns new-chat + theme, the Studio sidebar owns browsing, and
// the composer's model chip owns companion switching.) Rendered by ChatTab
// (the live mount) and switched to Mobile under the mobile breakpoint by
// Threshold.

import { useState } from 'react';
import type { ShellViewProps } from '../reimagine/useChatShell';
import { ChatThread } from '../reimagine/blocks';
import { Composer } from '../reimagine/Composer';
import {
  CounselPopover,
  ModelChip,
} from '../reimagine/CounselPicker';
import {
  RibbonTicker,
} from '../reimagine/RoomViews';
import { ROOM_NAMES } from '../../../data/roomNames';

export function Conversation({ s, picker, repo }: ShellViewProps) {
  const [counselOpen, setCounselOpen] = useState(false);

  return (
    <div className="rc rc-desktop">
      <div className="sky" aria-hidden="true">
        <Stars n={54} motes={7} />
      </div>
      <div className="shell">
        {/* ── main column ── */}
        <div className="main">
          <header className="top">
            <h2 className="hall-title">{ROOM_NAMES.hall.name}</h2>
            <span className="crumb">
              {repo?.name ?? 'ASSISTANT-HUB'} · {repo?.branch ?? 'master'}
            </span>
            <div className="presence">
              <span className="pulse" style={{ width: 7, height: 7 }} /> TARDIS online
            </div>
          </header>

          <RibbonTicker events={s.chronicle} />

          <main className="feed" ref={s.sticky.scrollRef} onScroll={s.sticky.onScroll}>
            <div className="feed-inner">
              <ChatThread
                blocks={s.blocks}
                status={s.status}
                contentRef={s.sticky.contentRef}
                bottomRef={s.sticky.bottomRef}
                suppressTyping={s.automationBusy}
                workingSince={s.workingSince}
              />
              {s.error ? (
                <div className="chip" style={{ color: 'var(--amber)', borderColor: 'color-mix(in oklch, var(--amber) 40%, transparent)', background: 'color-mix(in oklch, var(--amber) 10%, transparent)' }}>
                  ⚠ {s.error}
                </div>
              ) : null}
            </div>
          </main>

          <button
            type="button"
            className={`jump${s.sticky.unread > 0 || (!s.sticky.pinned && s.busy) ? ' show' : ''}`}
            onClick={s.sticky.jumpToBottom}
          >
            To the latest word
            {s.sticky.unread > 0 ? <span className="cnt">{s.sticky.unread}</span> : null}
          </button>

          <div className="dock">
            <div className="dock-inner">
              <CounselPopover picker={picker} open={counselOpen} onClose={() => setCounselOpen(false)} />
              <Composer
                chatId={s.chatId}
                value={s.value}
                onChange={s.setValue}
                onSend={s.send}
                onStop={s.stop}
                onSteer={s.steer}
                onFresh={s.fresh}
                busy={s.busy}
                commands={s.commands}
                modelChip={<ModelChip picker={picker} onClick={() => setCounselOpen((o) => !o)} />}
                onMellon={(rect) => s.sparks.burst(rect.left + rect.width / 2, rect.top + rect.height / 2)}
              />
            </div>
          </div>
        </div>
      </div>
      {s.sparks.sparks}
    </div>
  );
}


// Ambient starfield + gold motes (deterministic-enough random offsets).
function Stars({ n, motes }: { n: number; motes: number }) {
  const stars = Array.from({ length: n }, (_, i) => i);
  const ms = Array.from({ length: motes }, (_, i) => i);
  return (
    <>
      {stars.map((i) => (
        <span
          key={`s${i}`}
          className="st"
          style={{
            left: `${(i * 37) % 100}%`,
            top: `${(i * 61) % 100}%`,
            ['--d' as string]: `${2 + ((i * 7) % 40) / 10}s`,
            ['--dl' as string]: `${(i * 13) % 50 / 10}s`,
            ...(i % 3 === 0 ? { width: 1, height: 1 } : null),
          } as React.CSSProperties}
        />
      ))}
      {ms.map((i) => (
        <span
          key={`m${i}`}
          className="mote"
          style={{
            left: `${(i * 53) % 100}%`,
            ['--d' as string]: `${16 + ((i * 9) % 16)}s`,
            ['--dl' as string]: `${(i * 17) % 14}s`,
            ['--dx' as string]: `${((i * 29) % 60) - 30}px`,
          } as React.CSSProperties}
        />
      ))}
    </>
  );
}
