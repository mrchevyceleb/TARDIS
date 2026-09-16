import { useEffect } from 'react';
import { Threshold } from '../../chat/components/desktop/Threshold';
import { useChat } from '../../chat/hooks/useChat';
import { useCompanionPicker } from '../../chat/hooks/useCompanionPicker';
import type { Repo } from '../../chat/data/types';

export function companionAgentLabel(cli: string): string {
  switch (cli) {
    case 'assistant': return 'TARDIS';
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'banana': return 'OpenRouter';
    case 'banana-local': return 'Local';
    case 'banana-fireworks': return 'Fireworks';
    case 'zai': return 'GLM';
    case 'xai': return 'Grok 4.6';
    default: return cli;
  }
}

export type ChatTabApi = { send: (message: string) => void; companionLabel: string };

export function ChatTab({
  chatId,
  repo,
  registerApi,
}: {
  chatId: string;
  repo?: Repo;
  registerApi: (chatId: string, api: ChatTabApi | null) => void;
}) {
  const picker = useCompanionPicker(`rivendell:studio-companion:${chatId}`);

  const chat = useChat({
    repo,
    cli: picker.cli,
    account: picker.account ?? undefined,
    chatId,
    enabled: Boolean(repo),
    model: picker.model,
    effort: picker.effort,
    selectionRevision: picker.selectionRevision,
  });

  // Publish this tab's send() so the shell (file "Ask TARDIS", tree) can reach it.
  useEffect(() => {
    registerApi(chatId, { send: chat.send, companionLabel: companionAgentLabel(picker.cli) });
    return () => registerApi(chatId, null);
  }, [chatId, chat.send, picker.companion, registerApi]);

  return (
    <div className="studio-chattab">
      <Threshold chat={chat} picker={picker} repo={repo} agent={companionAgentLabel(picker.cli)} />
    </div>
  );
}
