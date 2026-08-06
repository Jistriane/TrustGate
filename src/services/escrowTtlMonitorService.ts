import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import cron, { ScheduledTask } from 'node-cron';
import {
  tgEscrowContractInstanceTtlDays,
  tgEscrowTtlFetchTotal,
} from '../config/workerMetrics';
import { logger } from '../config/logger';

const exec = promisify(execCb);

export interface EscrowTtlMonitorConfig {
  network: 'local' | 'testnet' | 'pubnet';
  contractId: string;
  /** Ledger seconds (Stellar default = 5s per ledger) */
  ledgerSeconds?: number;
  /** Default 30 day grace period — even if Soroban returns undefined, no crash. */
  defaultFallbackDays?: number;
  cronExpression?: string;
}

function shell(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return exec(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

export async function sorobanGetLedgerAndTtl(
  network: string,
  contractId: string,
): Promise<{ currentLedger: number; expiresAtLedger: number | null; method: string; diagnostics: { fetchStdoutLen?: number; statusStdoutLen?: number; parseErrorMsg?: string; fetchKeys?: string[]; instanceStorageKeys?: string[]; finalLedgerPath?: string; finalExpiryPath?: string } }> {
  const diagnostics: {
    fetchStdoutLen?: number; statusStdoutLen?: number; parseErrorMsg?: string;
    fetchKeys?: string[]; instanceStorageKeys?: string[]; finalLedgerPath?: string; finalExpiryPath?: string;
  } = {};

  // 4 real output formats of soroban CLI 22.x were observed in local standalone:
  //   Format A (ideal, already parsed):
  //     { currentLedger: 1234, instanceStorage: { ttl: 518400, liveUntilLedger: 519634 } }
  //   Format B (less common, uses latestLedger + nested storageTTL + instanceTTL):
  //     { latestLedger: 1234, instanceStorageTTL: { storage_ttl: 518400 } }
  //   Format C (raw ledger entry wrapper, pulled via soroban rpc getLedgerEntries):
  //     { entries: [{ ..., lastModifiedLedgerSeq: 1200, expirationLedgerSeq: 520000, ... }] }
  //   Format D (old CLI, just sequence + root ttlLedger keys):
  //     { sequence: 1234, ledgerInfo: { ttl: 518400 }, liveUntil: 519634 }
  // We handle ALL in a fallback stack using nested object walking.
  function walk(obj: any, path: (string | number)[]): any {
    let cur: any = obj;
    for (const k of path) {
      if (cur == null) return undefined;
      cur = Array.isArray(cur) ? cur[Number(k)] : cur[k];
    }
    return cur;
  }
  function firstNum(...candidates: (() => number | undefined | null)[]): number | null {
    for (const fn of candidates) {
      try {
        const v = fn();
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
      } catch { /* ignore */ }
    }
    return null;
  }

  try {
    const { stdout } = await shell(
      `soroban contract fetch --network ${network} --id ${contractId} --output json 2>/dev/null || true`,
    );
    diagnostics.fetchStdoutLen = stdout.length;
    if (stdout.trim()) {
      const parsed: any = JSON.parse(stdout);
      diagnostics.fetchKeys = Array.isArray(parsed) ? ['[array]'] : Object.keys(parsed ?? {});
      if (parsed?.instanceStorage) diagnostics.instanceStorageKeys = Object.keys(parsed.instanceStorage);

      const cur = firstNum(
        () => walk(parsed, ['currentLedger']),
        () => walk(parsed, ['latestLedger']),
        () => walk(parsed, ['sequence']),
        () => walk(parsed, ['entries', 0, 'lastModifiedLedgerSeq']),
        () => walk(parsed, ['ledger', 'sequence']),
      );
      const exp = firstNum(
        // explicit liveUntilLedger in instanceStorage (Format A)
        () => walk(parsed, ['instanceStorage', 'liveUntilLedger']),
        // sum current + ttl in same format A
        () => {
          const t = walk(parsed, ['instanceStorage', 'ttl']);
          const c = walk(parsed, ['currentLedger']) ?? walk(parsed, ['latestLedger']);
          return (typeof t === 'number' && typeof c === 'number') ? c + t : null;
        },
        // root liveUntil (Format D)
        () => walk(parsed, ['liveUntil']),
        // expirationLedgerSeq raw entry (Format C)
        () => walk(parsed, ['entries', 0, 'expirationLedgerSeq']),
        // old: top-level liveUntilLedger
        () => walk(parsed, ['liveUntilLedger']),
        // instanceStorageTTL.storage_ttl + current (Format B)
        () => {
          const t = walk(parsed, ['instanceStorageTTL', 'storage_ttl']);
          const c = walk(parsed, ['latestLedger']) ?? walk(parsed, ['currentLedger']);
          return (typeof t === 'number' && typeof c === 'number') ? c + t : null;
        },
      );

      // Saves diagnostics of the path that matched (if any)
      if (cur) diagnostics.finalLedgerPath = (walk(parsed, ['currentLedger']) ? 'currentLedger'
        : walk(parsed, ['latestLedger']) ? 'latestLedger'
          : walk(parsed, ['sequence']) ? 'sequence'
            : walk(parsed, ['entries', 0, 'lastModifiedLedgerSeq']) ? 'entries[0].lastModifiedLedgerSeq'
              : 'ledger.sequence');
      if (exp) diagnostics.finalExpiryPath = walk(parsed, ['instanceStorage', 'liveUntilLedger']) ? 'instanceStorage.liveUntilLedger'
        : walk(parsed, ['liveUntil']) ? 'liveUntil'
          : walk(parsed, ['entries', 0, 'expirationLedgerSeq']) ? 'entries[0].expirationLedgerSeq'
            : 'instanceStorage.ttl + currentLedger';

      if (cur && exp) return { currentLedger: cur, expiresAtLedger: exp, method: 'fetch:json', diagnostics };
    }
    // === If stdout is EMPTY (fetch:empty) or JSON parse didn't return valid (cur,exp):
    //     Do NOT return early. Let flow fall through below to Fallback B (soroban network status).
  } catch (err) {
    diagnostics.parseErrorMsg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    /* fallback below */
  }
  // Fallback B: soroban network status + rough assume liveUntilLedger ~ current + INSTANCE_TTL_EXTEND_TO (internal default 518_400 ~ 30d)
  try {
    const { stdout: statusOut } = await shell(
      `soroban network status --network ${network} 2>/dev/null || true`,
    );
    diagnostics.statusStdoutLen = statusOut.length;
    const m = statusOut.match(/ledger:\s*(\d+)/i) || statusOut.match(/latestLedger[:=]"?\s*(\d+)/i) || statusOut.match(/sequence[":=\s]+(\d+)/i);
    const cur = m ? parseInt(m[1], 10) || 0 : 0;
    if (cur) {
      return {
        currentLedger: cur,
        expiresAtLedger: cur + 518_400,
        // If we had fetchStdoutLen=0 above, we call this fetch:empty + status:fallback combined.
        // We keep legacy method status:fallback:518_400 as it's correctly interpreted in the Counter label.
        method: 'status:fallback:518_400',
        diagnostics,
      };
    }
  } catch {
    /* ignore */
  }
  // If empty fetch AND empty status = unavailable. If JSON parsed but invalid cur/exp AND empty status = also unavailable.
  return {
    currentLedger: 0,
    expiresAtLedger: null,
    // diagnostics.fetchStdoutLen === 0 → was fetch:empty (now fallback). But we still want the Counter to distinguish.
    method: (diagnostics.fetchStdoutLen ?? 0) === 0 && (diagnostics.statusStdoutLen ?? 0) === 0 ? 'unavailable' : 'status:fallback:518_400',
    diagnostics,
  };
}

export function ledgersToDays(n: number, ledgerSeconds = 5): number {
  return (n * ledgerSeconds) / (24 * 60 * 60);
}

export class EscrowTtlMonitorService {
  public readonly cfg: Required<EscrowTtlMonitorConfig>;

  constructor(cfg: EscrowTtlMonitorConfig) {
    this.cfg = {
      network: cfg.network,
      contractId: cfg.contractId,
      ledgerSeconds: cfg.ledgerSeconds ?? 5,
      defaultFallbackDays: cfg.defaultFallbackDays ?? 30,
      cronExpression: cfg.cronExpression ?? '0 */6 * * *',
    };
  }

  async tickOnce(): Promise<{ days: number; method: string }> {
    const { currentLedger, expiresAtLedger, method, diagnostics } = await sorobanGetLedgerAndTtl(
      this.cfg.network,
      this.cfg.contractId,
    );
    // P2-8 V16 quality metric: counter by method (fetch:json / fetch:empty / status:fallback:518_400 / unavailable).
    tgEscrowTtlFetchTotal.inc({ method });
    let days: number;
    if (!currentLedger || !expiresAtLedger) {
      days = this.cfg.defaultFallbackDays;
      logger.warn(
        { network: this.cfg.network, contractId: this.cfg.contractId, method, fallbackDays: days, diagnostics },
        '[EscrowTtlMonitor] Soroban fetch falhou — usando fallback defaultFallbackDays no gauge.',
      );
    } else {
      const remainingLedgers = Math.max(0, expiresAtLedger - currentLedger);
      days = Math.round(ledgersToDays(remainingLedgers, this.cfg.ledgerSeconds) * 100) / 100;
      logger.info(
        { network: this.cfg.network, contractId: this.cfg.contractId, currentLedger, expiresAtLedger, remainingLedgers: expiresAtLedger - currentLedger, days, method, diagnostics },
        '[EscrowTtlMonitor] TTL atualizado gauge prometheus.',
      );
    }
    tgEscrowContractInstanceTtlDays.set(days);
    return { days, method };
  }

  schedule(): ScheduledTask {
    logger.info(
      { network: this.cfg.network, cronExpression: this.cfg.cronExpression, contractId: this.cfg.contractId.slice(0, 10) + '…' },
      '[EscrowTtlMonitor] schedule() cron TTL instance storage.',
    );
    void this.tickOnce().catch((err) =>
      logger.warn({ err }, '[EscrowTtlMonitor] initial tick failed (non-fatal, no crash).'),
    );
    return cron.schedule(this.cfg.cronExpression, () => {
      void this.tickOnce().catch((err) =>
        logger.error({ err }, '[EscrowTtlMonitor] scheduled cron tick failed.'),
      );
    });
  }
}
