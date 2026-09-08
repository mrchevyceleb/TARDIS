// Shared types between mock + real-backend data shapes.

// TARDIS binds each companion to a CLI/provider via this id. Claude Code
// and Codex account choice comes from the selected repo's account-map rule.
// The banana engine picker switches the effective cli to claude, banana
// (OpenRouter), banana-fireworks, banana-local, zai, or xai.
export type CompanionId =
  | 'claude'
  | 'codex'
  | 'assistant'
  | 'banana'
  | 'banana-local'
  | 'banana-fireworks'
  | 'zai'
  | 'xai';

// A live session reported by /api/live — used to mark "running now" entries
// in the chronicle ribbon.
export type LiveSession = {
  cli: CompanionId;
  cwd: string;
  chatId: string;
  repoName: string;
  busy: boolean;
  sessionId: string | null;
  lastActivityAt: number;
};

export type Repo = {
  path: string;        // absolute filesystem path
  name: string;        // display name (basename of path)
  branch?: string;
  hub?: string;        // grouping label (e.g., "Personal-Apps", "The Hub")
  pinned?: boolean;
  isAssistantHub?: boolean;
  // Mock/UI-only flags below — synthesized from chronicle data later.
  recent?: string;
  awaits?: boolean;
  italic?: boolean;
};

export type CommandEntry = {
  name: string;
  title?: string;
  description?: string;
};

export type CommandCatalog = {
  claude: CommandEntry[];
  codex: CommandEntry[];
  banana: CommandEntry[];
};

export type ChatImagePreview = {
  mediaType: string;
  dataUrl: string;
};

// Re-export for places that use it — kept here since it's a UI-facing type.

// Conversation block — the renderable unit in the chat thread.
// `turnId` + `cbIndex` correlate a block back to claude's content_block_*
// stream events so the reducer stays pure (no out-of-band Maps).
export type ChatBlock =
  | { kind: 'user'; id: string; text: string; ts: number; images?: ChatImagePreview[]; imageCount?: number; clientMsgId?: string; attachmentsLost?: boolean; deliveryState?: 'queued' | 'failed' }
  | {
      /** Agent-to-agent delivery (team bus): a teammate's message arriving in
       *  this thread — rendered with the SENDER's identity, not as a user turn. */
      kind: 'peer';
      id: string;
      from: string;
      fromRole?: string;
      /** Stable durable delivery id; retries reuse it and render only once. */
      deliveryId?: string;
      text: string;
      ts: number;
    }
  | {
      /** Auto-compaction marker — the thread's model context rotated with a
       *  juicy durable summary saved to the RAG vault. The visible history
       * above/below is untouched (forever-thread). */
      kind: 'compact';
      id: string;
      ts: number;
      words: number;
      turns: number;
      count: number;
      savedToRag?: boolean;
    }
  | {
      /** Service restarted mid-turn — the in-flight tool call's output was
       *  lost with the process. Rendered as a divider (never a bubble). */
      kind: 'restart';
      id: string;
      ts: number;
      reason?: string;
    }
  | {
      /** Durable provider failure. This is visible to the user but excluded
       * from future model context and sidebar conversation previews. */
      kind: 'terminal-error';
      id: string;
      message: string;
      code?: string;
      retryable?: boolean;
      ts: number;
    }
  | {
      /** Brain change mid-thread. The conversation continues; only the engine
       *  that will answer the next turn changed. */
      kind: 'switch';
      id: string;
      from: string;
      to: string;
      model?: string;
      ts: number;
    }
  | {
      kind: 'text';
      id: string;
      text: string;
      ts: number;
      folio?: string;
      /** Provider-tagged tool-bound update vs completed answer. This is a
       * presentation distinction, never a reason to hide user-facing text. */
      presentation?: 'update' | 'answer';
      turnId?: string;
      /** Teammate message this response belongs to, when applicable. */
      peerId?: string;
      cbIndex?: number;
      open?: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      toolUseId: string;
      tool: string;
      args: string;
      result?: string;
      running: boolean;
      ts: number;
      turnId?: string;
      /** Teammate message this tool activity belongs to, when applicable. */
      peerId?: string;
      cbIndex?: number;
      open?: boolean;
    }
  | {
      kind: 'doc-link';
      id: string;
      ts: number;
      path: string;
      title?: string;
      turnId?: string;
      cbIndex?: number;
    }
  | {
      kind: 'folder-link';
      id: string;
      ts: number;
      path: string;
      title?: string;
      turnId?: string;
      cbIndex?: number;
    }
  | {
      kind: 'artifact';
      id: string;
      ts: number;
      artifactId: string;
      artifactKind: 'html' | 'markdown' | 'text';
      title: string;
      turnId?: string;
      cbIndex?: number;
    };
