/** Matt, Oct 20: history is looked up explicitly. No message or session
 * start receives automatic memory, notes, card or transcript excerpts. */
export function recallEligibleTurn(
  _chatId: string,
  _opts: { peerFrom?: string; peerFromRole?: string; hidden?: boolean; automation?: boolean; voiceMode?: boolean } = {},
): boolean { return false; }

export async function recallBlockForTurn(_args: {
  cli: string; cwd: string; chatId: string; logKey: string; messageText: string;
}): Promise<string> { return ''; }
