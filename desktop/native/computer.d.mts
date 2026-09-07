export type ControlStatus = { supported: boolean; reason?: string; approvalMode?: 'ask' | 'automatic'; paused?: boolean; control: { owner: string; label: string; purpose: string; expiresAt: number } | null };
export type ControlRequest = { owner: string; label: string; purpose: string; minutes: number };
export function trustedComputerUrl(raw: string): boolean;
export function desktopIdentity(): string;
export class ComputerController {
  constructor(options: { approve: (request: ControlRequest, signal: AbortSignal) => Promise<boolean>; automatic?: () => boolean; changed?: (status: ControlStatus) => void;
    encode?: (png: Buffer, region: { left: number; top: number; width: number; height: number }) => Promise<{ data: Buffer; info: { width: number; height: number } }>;
    adapter?: {
    capability: { supported: boolean; reason?: string };
    inspect(signal: AbortSignal): Promise<any>;
    capture(signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number } }>;
    act(action: Record<string, any>, signal: AbortSignal): Promise<unknown>;
    release(): Promise<unknown>;
  } });
  status(): ControlStatus;
  stop(pause?: boolean): void;
  handle(op: string, params?: Record<string, unknown>): Promise<any>;
}
