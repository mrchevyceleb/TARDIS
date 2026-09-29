export const COMPUTER_GRANT_MINUTES: number;
export const COMPUTER_GRANT_MS: number;
export type ControlStatus = { supported: boolean; reason?: string; approvalMode?: 'ask' | 'automatic'; paused?: boolean; control: { owner: string; label: string; purpose: string; expiresAt: number } | null };
/** What the person at a Mac has allowed for TARDIS so far. */
export type PermissionStatus = { screenRecording: boolean; accessibility: boolean; locked: boolean; displayAsleep: boolean; displays: number };
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
    // Windows background window control. Absent on other adapters; the
    // window_capture/uia ops refuse cleanly when these are missing.
    windowCapture?(window: string, signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number }; process?: string }>;
    uiaTree?(window: string, focus: 'interactive' | undefined, signal: AbortSignal): Promise<{ process?: string; elements: any[]; truncated: boolean; focus?: boolean }>;
    uiaValue?(window: string, element: string, text: string, name: string | undefined, post: boolean, append: boolean, signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number }; postedTo?: number }>;
    uiaFocus?(window: string, element: string, name: string | undefined, signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number } }>;
    uiaInvoke?(window: string, element: string, name: string | undefined, signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number } }>;
    uiaKey?(window: string, keys: string[], signal: AbortSignal): Promise<{ png: Buffer; bounds: { x: number; y: number; width: number; height: number }; postedTo?: number }>;
  } });
  /** The platform adapter. macOS adds the two setup methods. */
  readonly adapter: { requestPermissions?(): Promise<PermissionStatus>; permissionStatus?(): Promise<PermissionStatus> };
  status(): ControlStatus;
  stop(pause?: boolean): void;
  handle(op: string, params?: Record<string, unknown>): Promise<any>;
}
