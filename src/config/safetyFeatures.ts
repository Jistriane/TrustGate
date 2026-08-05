export interface SafetyFeatures {
  pauseNewTasks: boolean;
  pauseNewBids: boolean;
  pauseWorkerConsumption: boolean;
  executorDenylist: Set<string>;
  escrowImplementation: 'trustlesswork' | 'mock';
  trustlessWorkWebhookPublicKey?: string;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const lower = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  throw new Error(
    `[safetyFeatures] Invalid boolean for ${name}: expected true/false/1/0/yes/no/on/off, got "${raw}"`,
  );
}

function parseExecutorDenylist(raw: string | undefined): Set<string> {
  if (!raw || !raw.trim()) return new Set<string>();
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = items.filter((s) => !/^G[A-Z2-7]{55}$/.test(s));
  if (invalid.length > 0) {
    throw new Error(
      `[safetyFeatures] EXECUTOR_DENYLIST contains invalid Stellar addresses: ${invalid.join(', ')}`,
    );
  }
  return new Set<string>(items);
}

function parseEscrowImplementation(raw: string | undefined): SafetyFeatures['escrowImplementation'] {
  const lower = (raw ?? 'trustlesswork').trim().toLowerCase();
  if (lower === 'trustlesswork' || lower === 'mock') {
    return lower;
  }
  throw new Error(
    `[safetyFeatures] Invalid ESCROW_IMPLEMENTATION: expected "trustlesswork" or "mock", got "${raw}"`,
  );
}

function parseOptionalStringMinLen(raw: string | undefined, envName: string, minLen: number): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length < minLen) {
    throw new Error(
      `[safetyFeatures] ${envName} too short: expected >= ${minLen} chars when set, got ${trimmed.length}`,
    );
  }
  return trimmed;
}

let cached: SafetyFeatures | null = null;

export function loadSafetyFeatures(): SafetyFeatures {
  if (cached) return cached;
  cached = {
    pauseNewTasks: parseBoolEnv('PAUSE_NEW_TASKS', false),
    pauseNewBids: parseBoolEnv('PAUSE_NEW_BIDS', false),
    pauseWorkerConsumption: parseBoolEnv('PAUSE_WORKER_CONSUMPTION', false),
    executorDenylist: parseExecutorDenylist(process.env.EXECUTOR_DENYLIST),
    escrowImplementation: parseEscrowImplementation(process.env.ESCROW_IMPLEMENTATION),
    trustlessWorkWebhookPublicKey: parseOptionalStringMinLen(
      process.env.TRUSTLESS_WORK_WEBHOOK_PUBLIC_KEY,
      'TRUSTLESS_WORK_WEBHOOK_PUBLIC_KEY',
      32,
    ),
  };
  return cached;
}

export function __unsafeResetSafetyFeaturesCacheForTests(): void {
  cached = null;
}
