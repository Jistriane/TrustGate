/**
 * src/services/escrowTtlMonitorService.test.ts
 * =================================================
 * P0-5 V17 Robust parser for 4 real soroban 22.x formats.
 *
 * Jest ISO — Does NOT call real soroban. We mock `child_process.exec`
 * at the TOP-LEVEL via jest.mock (jest hoisting, required for core modules).
 *
 * 6 parse scenarios + 1 ledgersToDays util = **7 ISO tests**.
 */

// jest.mock AT THE TOP (outside IIFE / functions). Jest hoists THIS declaration to
// the absolute start of the module, replacing `child_process.exec` before the
// service imports `node:child_process` via promisify.
jest.mock('node:child_process', () => {
  const { promisify } = require('node:util');
  let rule: ((cmd: string) => { stdout: string; stderr: string }) = () => ({ stdout: '', stderr: '' });
  const execFn: any = (cmd: string, arg2?: unknown, arg3?: unknown) => {
    // exec style normal callback (kept for use without promisify):
    let callback: any;
    if (typeof arg2 === 'function') callback = arg2;
    else if (typeof arg3 === 'function') callback = arg3;
    const pair = rule(cmd);
    if (callback) {
      setImmediate(() => callback(null, pair.stdout, pair.stderr));
    }
    return {} as any;
  };
  // ===== FINAL KEY =====
  // `util.promisify(exec)` first checks for `exec[kCustomPromisify]` if it exists.
  // Without this, it falls back to normal promisify which calls exec(cmd, opts, cb),
  // but node:util sometimes uses custom `[Symbol]` if present — and here we
  // implement it to BE SURE promisify will call our code deterministically.
  const kCustomPromisify = promisify.custom;
  Object.defineProperty(execFn, kCustomPromisify, {
    value: (cmd: string, _opts?: any) => new Promise((resolve) => {
      const pair = rule(cmd);
      setImmediate(() => resolve({ stdout: pair.stdout, stderr: pair.stderr }));
    }),
    configurable: true,
  });
  execFn.mock = undefined; // placeholder
  // jest.fn wrapper (to keep `jest.fn()` API) — BUT the real execFn already has correct behavior.
  const mockExec = jest.fn(execFn);
  // Re-paste custom promisify on the mock, since jest.fn discards properties:
  Object.defineProperty(mockExec, kCustomPromisify, {
    value: execFn[kCustomPromisify],
    configurable: true,
  });
  const api: any = {
    exec: mockExec,
    __setRule(fn: any) { rule = fn; },
  };
  return api;
});

import { sorobanGetLedgerAndTtl, ledgersToDays } from './escrowTtlMonitorService';
import * as cp from 'node:child_process';

const cpMock = cp as unknown as {
  exec: jest.Mock;
  __setRule: (fn: (cmd: string) => { stdout: string; stderr: string }) => void;
};

describe('escrowTtlMonitorService P0-5 V17 (parser 4 soroban 22.x formats)', () => {
  beforeEach(() => {
    cpMock.exec.mockClear();
    cpMock.__setRule(() => ({ stdout: '', stderr: '' }));
  });

  it('Format A — currentLedger + instanceStorage.liveUntilLedger (fetch:json)', async () => {
    cpMock.__setRule((cmd) => /contract fetch/.test(cmd) ? ({
      stdout: JSON.stringify({
        currentLedger: 1234,
        instanceStorage: { ttl: 518_400, liveUntilLedger: 519_634 },
      }),
      stderr: '',
    }) : ({ stdout: '', stderr: '' }));
    const r = await sorobanGetLedgerAndTtl('local', 'CCONTRACT123');
    expect(r.method).toBe('fetch:json');
    expect(r.currentLedger).toBe(1234);
    expect(r.expiresAtLedger).toBe(519_634);
    expect(r.diagnostics.finalLedgerPath).toBe('currentLedger');
    expect(r.diagnostics.finalExpiryPath).toBe('instanceStorage.liveUntilLedger');
    expect(r.diagnostics.fetchKeys).toEqual(['currentLedger', 'instanceStorage']);
  });

  it('Format B — latestLedger + instanceStorageTTL.storage_ttl (sums for expiry)', async () => {
    cpMock.__setRule((cmd) => /contract fetch/.test(cmd) ? ({
      stdout: JSON.stringify({
        latestLedger: 5000,
        instanceStorageTTL: { storage_ttl: 200_000 },
      }),
      stderr: '',
    }) : ({ stdout: '', stderr: '' }));
    const r = await sorobanGetLedgerAndTtl('local', 'C');
    expect(r.method).toBe('fetch:json');
    expect(r.currentLedger).toBe(5000);
    expect(r.expiresAtLedger).toBe(5000 + 200_000);
    expect(r.diagnostics.finalLedgerPath).toBe('latestLedger');
    expect(r.diagnostics.finalExpiryPath).toBe('instanceStorage.ttl + currentLedger');
  });

  it('Format C — entries[0].expirationLedgerSeq (raw getLedgerEntries result)', async () => {
    cpMock.__setRule((cmd) => /contract fetch/.test(cmd) ? ({
      stdout: JSON.stringify({
        entries: [{ lastModifiedLedgerSeq: 9999, expirationLedgerSeq: 600_000 }],
      }),
      stderr: '',
    }) : ({ stdout: '', stderr: '' }));
    const r = await sorobanGetLedgerAndTtl('local', 'C');
    expect(r.method).toBe('fetch:json');
    expect(r.currentLedger).toBe(9999);
    expect(r.expiresAtLedger).toBe(600_000);
    expect(r.diagnostics.finalLedgerPath).toBe('entries[0].lastModifiedLedgerSeq');
    expect(r.diagnostics.finalExpiryPath).toBe('entries[0].expirationLedgerSeq');
  });

  it('Format D — root sequence + root liveUntil (early soroban 22 CLI)', async () => {
    cpMock.__setRule((cmd) => /contract fetch/.test(cmd) ? ({
      stdout: JSON.stringify({
        sequence: 2020,
        ledgerInfo: { ttl: 300_000 },
        liveUntil: 303_000,
      }),
      stderr: '',
    }) : ({ stdout: '', stderr: '' }));
    const r = await sorobanGetLedgerAndTtl('local', 'C');
    expect(r.method).toBe('fetch:json');
    expect(r.currentLedger).toBe(2020);
    expect(r.expiresAtLedger).toBe(303_000);
    expect(r.diagnostics.finalLedgerPath).toBe('sequence');
    expect(r.diagnostics.finalExpiryPath).toBe('liveUntil');
  });

  it('empty fetch + soroban network status "ledger: 5500" → status:fallback:518_400', async () => {
    cpMock.__setRule((cmd) => {
      if (/contract fetch/.test(cmd)) return { stdout: '', stderr: '' };
      if (/network status/.test(cmd)) return {
        stdout: 'soroban 22.0.1\nRPC: http://localhost:8000/soroban/rpc\nnetwork: standalone\nledger: 5500\n',
        stderr: '',
      };
      return { stdout: '', stderr: '' };
    });
    const r = await sorobanGetLedgerAndTtl('local', 'C');
    expect(r.method).toBe('status:fallback:518_400');
    expect(r.currentLedger).toBe(5500);
    expect(r.expiresAtLedger).toBe(5500 + 518_400);
    expect(r.diagnostics.fetchStdoutLen).toBe(0);
    expect(typeof r.diagnostics.statusStdoutLen === 'number' && r.diagnostics.statusStdoutLen > 30).toBe(true);
  });

  it('fetch and status both empty → unavailable (0 / null)', async () => {
    cpMock.__setRule(() => ({ stdout: '', stderr: '' }));
    const r = await sorobanGetLedgerAndTtl('local', 'C');
    expect(r.method).toBe('unavailable');
    expect(r.currentLedger).toBe(0);
    expect(r.expiresAtLedger).toBeNull();
    expect(r.diagnostics.fetchStdoutLen).toBe(0);
    expect(r.diagnostics.statusStdoutLen).toBe(0);
  });

  it('util ledgersToDays exact conversion', () => {
    // 1 day = 86400s / 5s per ledger = 17280 ledgers
    expect(ledgersToDays(17_280, 5)).toBe(1);
    // default 30 days = 518400 ledgers
    expect(ledgersToDays(518_400, 5)).toBe(30);
    // 1 ledger = 5/86400
    expect(ledgersToDays(1, 5)).toBe(5 / 86_400);
  });
});
