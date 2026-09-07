// One bounded journal per live device grant. Retrying a vision step after a
// lost HTTP response must not capture a fresh frame and click a second time.
export type StepOutcome = { acted: boolean | 'unknown'; observation: string; capturedAt?: number; pending?: boolean };
type RecordEntry = { fingerprint: string; outcome?: StepOutcome };
export class ComputerStepJournal {
  private grants = new Map<string, { session: string; steps: Map<string, RecordEntry> }>();
  beginGrant(device: string, session: string): void {
    if (this.grants.get(device)?.session === session) return;
    this.grants.set(device, { session, steps: new Map() });
  }
  forget(device: string): void { this.grants.delete(device); }
  retainDevices(online: Set<string>): void {
    for (const id of this.grants.keys()) if (!online.has(id)) this.grants.delete(id);
  }
  async run(device: string, session: unknown, stepId: unknown, fingerprint: string,
    perform: (markInput: (outcome?: StepOutcome) => void) => Promise<StepOutcome>,
  ): Promise<StepOutcome & { stepId: string; replayed?: boolean }> {
    if (typeof stepId !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(stepId)) throw new Error('A unique stepId is required. Reuse the same id only when retrying the same step.');
    const grant = this.grants.get(device);
    if (!grant || grant.session !== session) throw new Error('Start a desktop grant before running vision steps.');
    const previous = grant.steps.get(stepId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('stepId was already used for a different goal/display. Use a new id for a new step.');
      return { ...(previous.outcome ?? { acted: 'unknown', pending: true, observation: 'This step is still running. Reuse this stepId to check it; do not submit an equivalent step with a new id.' }), stepId, replayed: true };
    }
    if (grant.steps.size >= 256) throw new Error('This grant has reached its vision-step limit. Release it and start a new grant; do not replay completed steps.');
    const entry: RecordEntry = { fingerprint };
    grant.steps.set(stepId, entry);
    const markInput = (outcome?: StepOutcome) => {
      entry.outcome = outcome ?? { acted: 'unknown', observation: 'Input may already have run. Do not repeat this step; inspect the current screen before continuing.' };
    };
    try {
      entry.outcome = await perform(markInput);
      return { ...entry.outcome, stepId };
    } catch (error) {
      if (entry.outcome) {
        const detail = error instanceof Error ? error.message : String(error);
        entry.outcome = { ...entry.outcome, observation: `${entry.outcome.observation} Device detail: ${detail.slice(0, 800)}` };
        return { ...entry.outcome, stepId };
      }
      // Proven pre-input failure: allowing this id again cannot duplicate input.
      grant.steps.delete(stepId);
      throw error;
    }
  }
}
