import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, platform, totalmem } from 'node:os';
import { dirname, join } from 'node:path';

// When available system memory drops below this, spawning another agent child
// is likely to make macOS kill the new process. On macOS, raw "free" pages are
// often tiny even when memory pressure is healthy, so include reclaimable page
// classes instead of gating on Pages free alone.
function memoryReserve(capacity = totalmem()): number {
  const strict = !!process.env.RIVENDELL_RESOURCE_GUARD && process.env.RIVENDELL_RESOURCE_GUARD !== 'off';
  const floor = strict ? 2 * 1024 ** 3 : 750 * 1024 ** 2;
  return Math.max(floor, capacity * (strict ? 0.10 : 0.05));
}

function cgroupReserve(capacity: number): number {
  const strict = !!process.env.RIVENDELL_RESOURCE_GUARD && process.env.RIVENDELL_RESOURCE_GUARD !== 'off';
  return Math.min(memoryReserve(), Math.max(128 * 1024 ** 2, capacity * (strict ? 0.10 : 0.05)));
}

type MemorySource = 'memory_pressure' | 'vm_stat' | 'meminfo' | 'os';
type MemorySnapshot = { availableBytes: number; source: MemorySource; capacityBytes?: number };
type MemoryGuardResult =
  | { ok: true }
  | { ok: false; availableMb: number; totalMb: number; source: MemorySource };

export class MemoryPressureSpawnError extends Error {
  readonly code = 'RIVENDELL_MEMORY_PRESSURE';

  constructor(cli: string, result: Exclude<MemoryGuardResult, { ok: true }>) {
    super(
      `system memory pressure too high to spawn ${cli} ` +
      `(${result.availableMb} MB available via ${result.source} of ${result.totalMb} MB total). ` +
      'TARDIS held this launch to keep the machine responsive. Existing work stays running; try again after pressure eases.',
    );
    this.name = 'MemoryPressureSpawnError';
  }
}

export function assertMemoryAvailableForSpawn(cli: string): void {
  const guard = checkMemoryGuard();
  if (!guard.ok) {
    const error = new MemoryPressureSpawnError(cli, guard);
    console.warn(`[chat ${cli}] memory-guard refused spawn: ${error.message}`);
    throw error;
  }
}

function checkMemoryGuard(): MemoryGuardResult {
  const snapshot =
    readMacVmStatAvailableMemory() ??
    readMacMemoryPressure() ??
    readLinuxMemAvailable() ??
    { availableBytes: freemem(), source: 'os' as const };
  const hostMinimum = memoryReserve();
  const minimumBytes = snapshot.capacityBytes === undefined ? hostMinimum
    : cgroupReserve(snapshot.capacityBytes);
  if (snapshot.availableBytes >= minimumBytes) return { ok: true };
  return {
    ok: false,
    availableMb: Math.round(snapshot.availableBytes / (1024 * 1024)),
    totalMb: Math.round((snapshot.capacityBytes ?? totalmem()) / (1024 * 1024)),
    source: snapshot.source,
  };
}

// Reads a cgroup numeric file. Returns null for missing files, blanks, or the
// "max" / huge-sentinel values that mean "no limit".
function readCgroupInt(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw === '' || raw === 'max') return null;
    const n = Number(raw);
    // cgroup v1 encodes "unlimited" as a value near 2^63, well past the safe
    // integer range; treat anything that large as no limit.
    if (!Number.isFinite(n) || n >= Number.MAX_SAFE_INTEGER) return null;
    return n;
  } catch {
    return null;
  }
}

// Host-level allocatable memory from /proc/meminfo (kernel's own estimate, far
// better than `free` alone). Reports kB; convert to bytes.
function readProcMemAvailable(): number | null {
  try {
    const out = readFileSync('/proc/meminfo', 'utf8');
    const match = out.match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (!match) return null;
    const kb = Number(match[1]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// If TARDIS runs under a cgroup memory limit (container or systemd
// MemoryMax), the host MemAvailable can look healthy while this process's own
// cgroup is near OOM. Return the cgroup's available bytes (limit - current)
// when a finite limit is set, else null. cgroup v2 first, then v1.
function readCgroupAvailableBytes(): { bytes: number; capacity: number } | null {
  // Limits live at the process's membership path, and any ancestor may be
  // tighter. Reading only the mount root silently ignored systemd limits.
  let membership: string;
  try { membership = readFileSync('/proc/self/cgroup', 'utf8'); } catch { return null; }
  let available: { bytes: number; capacity: number } | null = null;
  for (const line of membership.trim().split('\n')) {
    const [hierarchy, controllers, ...parts] = line.split(':');
    const v2 = hierarchy === '0' && controllers === '';
    if (!v2 && !controllers?.split(',').includes('memory')) continue;
    const root = v2 ? '/sys/fs/cgroup' : '/sys/fs/cgroup/memory';
    let dir = join(root, parts.join(':'));
    for (;;) {
      const max = readCgroupInt(join(dir, v2 ? 'memory.max' : 'memory.limit_in_bytes'));
      const used = readCgroupInt(join(dir, v2 ? 'memory.current' : 'memory.usage_in_bytes'));
      if (max !== null && used !== null) {
        // Inactive file cache can be reclaimed by the kernel. Counting it as
        // committed RAM can hold every launch even with healthy host memory.
        let reclaimable = 0;
        try {
          const stats = readFileSync(join(dir, 'memory.stat'), 'utf8');
          reclaimable = Number(stats.match(v2 ? /^inactive_file (\d+)$/m : /^total_inactive_file (\d+)$/m)?.[1] ?? 0);
        } catch { /* conservative headroom when cache accounting is absent */ }
        const bytes = Math.max(0, max - used + Math.min(used, reclaimable));
        if (available === null || bytes / cgroupReserve(max) < available.bytes / cgroupReserve(available.capacity)) available = { bytes, capacity: max };
      }
      if (dir === root || !dir.startsWith(`${root}/`)) break;
      dir = dirname(dir);
    }
  }
  return available;
}

// Linux equivalent of the macOS readers above. Take the tighter of host
// MemAvailable and the process's cgroup headroom so a memory-capped service
// can't green-light a spawn that the cgroup would immediately OOM-kill.
function readLinuxMemAvailable(): MemorySnapshot | null {
  if (platform() !== 'linux') return null;
  const host = readProcMemAvailable();
  if (host === null) return null;
  // Host pressure and service headroom are separate checks: a small server
  // cgroup must not be required to hold 10% of the entire host's RAM free.
  if (host < memoryReserve()) return { availableBytes: host, source: 'meminfo' };
  const cgroup = readCgroupAvailableBytes();
  return cgroup !== null && cgroup.bytes < host
    ? { availableBytes: cgroup.bytes, capacityBytes: cgroup.capacity, source: 'meminfo' }
    : { availableBytes: host, source: 'meminfo' };
}

function readMacMemoryPressure(): MemorySnapshot | null {
  if (platform() !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/memory_pressure', [], { encoding: 'utf8', timeout: 1000 });
    const match = out.match(/System-wide memory free percentage:\s+(\d+(?:\.\d+)?)%/);
    if (!match) return null;
    const ratio = Number(match[1]) / 100;
    if (!Number.isFinite(ratio)) return null;
    return {
      availableBytes: Math.max(0, Math.min(totalmem(), totalmem() * ratio)),
      source: 'memory_pressure',
    };
  } catch {
    return null;
  }
}

function readMacVmStatAvailableMemory(): MemorySnapshot | null {
  if (platform() !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1000 });
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    if (!pageSizeMatch) return null;
    const pageSize = Number(pageSizeMatch[1]);
    if (!Number.isFinite(pageSize)) return null;
    const freePages = readVmStatPages(out, 'Pages free');
    if (freePages === null) return null;
    const availablePages =
      freePages +
      (readVmStatPages(out, 'Pages inactive') ?? 0) +
      (readVmStatPages(out, 'Pages speculative') ?? 0) +
      (readVmStatPages(out, 'Pages purgeable') ?? 0);
    return { availableBytes: pageSize * availablePages, source: 'vm_stat' };
  } catch {
    return null;
  }
}

function readVmStatPages(out: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = out.match(new RegExp(`${escaped}:\\s+([\\d,]+)\\.`));
  if (!match) return null;
  const pages = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(pages) ? pages : null;
}
