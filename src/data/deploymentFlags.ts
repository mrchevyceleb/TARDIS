import { useEffect, useState } from 'react';
import { fetchDeploymentFlags } from './api';

export type DeploymentFlags = { contentRoom: boolean };

/** Resolved once per page load and shared by every caller. The server decides
 *  which optional surfaces this deployment runs; nothing here is per-user. */
const DEFAULTS: DeploymentFlags = { contentRoom: true };
let cached: DeploymentFlags | null = null;
let inFlight: Promise<DeploymentFlags> | null = null;

function load(): Promise<DeploymentFlags> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= fetchDeploymentFlags().then((flags) => {
    cached = flags;
    inFlight = null;
    return flags;
  });
  return inFlight;
}

export function useDeploymentFlags(): DeploymentFlags {
  const [flags, setFlags] = useState<DeploymentFlags>(cached ?? DEFAULTS);
  useEffect(() => {
    let live = true;
    void load().then((next) => { if (live) setFlags(next); });
    return () => { live = false; };
  }, []);
  return flags;
}
