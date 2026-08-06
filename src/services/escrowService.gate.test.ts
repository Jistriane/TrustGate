import { ourOwnImplGate } from './escrowService';

const HEX_64_A = 'a'.repeat(64);
const HEX_64_B = 'b'.repeat(64);
const CONTRACT_ID = 'C'.repeat(56);

function fullClear(): Record<string, string> {
  return {
    ESCROW_SECURITY_L2_PASSED: 'true',
    ESCROW_L1_SIGN_OFF_1: 'dev1@trustgate.app',
    ESCROW_L1_SIGN_OFF_2: 'dev2@trustgate.app',
    ESCROW_AUDIT_SHA256_1: HEX_64_A,
    ESCROW_AUDIT_SHA256_2: HEX_64_B,
    ESCROW_OUROWN_ALLOW_STAGING: 'true',
  };
}

describe('ourOwnImplGate — 4 stages L2→L1→Audits→Feature-flag (P0-6 ADR0003)', () => {
  it('GATE 0 default: no env vars → allowed=false, reasons fill 4 gates + empty warnings', () => {
    const r = ourOwnImplGate({}, 'testnet', CONTRACT_ID);
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
    expect(r.reasons.some(s => s.includes('GATE 1/4'))).toBe(true);
    expect(r.reasons.some(s => s.includes('GATE 2/4'))).toBe(true);
    expect(r.reasons.some(s => s.includes('GATE 3/4'))).toBe(true);
    expect(r.warnings.length).toBe(0);
  });

  it('GATE DEBUG LOCAL-ONLY bypass: DEBUG_UNSAFE=true + NODE_ENV=development + network=local → allowed=true warnings.length=1', () => {
    const r = ourOwnImplGate(
      { DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'true', NODE_ENV: 'development' },
      'local',
      CONTRACT_ID,
    );
    expect(r.allowed).toBe(true);
    expect(r.warnings.some(w => /permitindo real impl/i.test(w))).toBe(true);
  });

  it('GATE DEBUG IGNORED PUBNET: DEBUG_UNSAFE=true + NODE_ENV=production + network=pubnet → allowed=false and warnings say IGNORED', () => {
    const r = ourOwnImplGate(
      { DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'true', NODE_ENV: 'production' },
      'pubnet',
      CONTRACT_ID,
    );
    expect(r.allowed).toBe(false);
    expect(r.warnings.some(w => /IGNORADO/i.test(w))).toBe(true);
  });

  it('GATE 1 ONLY (L2 passed=true, rest default) → blocks GATE 2/3/4, allowed=false', () => {
    const env = { ESCROW_SECURITY_L2_PASSED: 'true' };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.allowed).toBe(false);
    expect(r.reasons.every(s => !s.includes('GATE 1/4'))).toBe(true);
    expect(r.reasons.some(s => s.includes('GATE 2/4'))).toBe(true);
    expect(r.reasons.some(s => s.includes('GATE 3/4'))).toBe(true);
  });

  it('GATE 1 + GATE 2 (2 DIFFERENT independent signatures, valid) → blocks GATE 3 and 4', () => {
    const env: Record<string, string> = {
      ESCROW_SECURITY_L2_PASSED: 'true',
      ESCROW_L1_SIGN_OFF_1: 'joao@trustgate.app',
      ESCROW_L1_SIGN_OFF_2: 'maria@trustgate.app',
    };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some(s => s.includes('GATE 1/4'))).toBe(false);
    expect(r.reasons.some(s => s.includes('GATE 2/4'))).toBe(false);
    expect(r.reasons.some(s => s.includes('GATE 3/4'))).toBe(true);
  });

  it('GATE 2 INVALID: sign1 === sign2 → blocks GATE 2/4', () => {
    const env: Record<string, string> = {
      ESCROW_SECURITY_L2_PASSED: 'true',
      ESCROW_L1_SIGN_OFF_1: 'same@trustgate.app',
      ESCROW_L1_SIGN_OFF_2: 'same@trustgate.app',
    };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.reasons.some(s => s.includes('GATE 2/4'))).toBe(true);
  });

  it('GATE 3 INVALID: audit1 === audit2 (same SHA256) → blocks GATE 3/4', () => {
    const env: Record<string, string> = {
      ...fullClear(),
      ESCROW_AUDIT_SHA256_1: HEX_64_A,
      ESCROW_AUDIT_SHA256_2: HEX_64_A,
    };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.reasons.some(s => s.includes('GATE 3/4'))).toBe(true);
  });

  it('GATE 3 INVALID: audit1 has 63 chars (less than 64 hex) → blocks GATE 3', () => {
    const env: Record<string, string> = {
      ...fullClear(),
      ESCROW_AUDIT_SHA256_1: 'a'.repeat(63),
    };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.reasons.some(s => s.includes('GATE 3/4'))).toBe(true);
  });

  it('GATE 4 STAGING: 1+2+3 OK + ESCROW_OUROWN_ALLOW_STAGING=false (default) → allowed=false reason GATE 4/4 staging', () => {
    const env = { ...fullClear(), ESCROW_OUROWN_ALLOW_STAGING: 'false' };
    const r = ourOwnImplGate(env, 'testnet', CONTRACT_ID);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some(s => s.includes('GATE 4/4') && /staging/i.test(s))).toBe(true);
  });

  it('VALID STAGING RELEASE: 1+2+3 OK + ESCROW_OUROWN_ALLOW_STAGING=true + network=testnet → allowed=true reasons=[] warnings=[]', () => {
    const r = ourOwnImplGate(fullClear(), 'testnet', CONTRACT_ID);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('GATE 4 PUBNET: 1+2+3 OK + ALLOW_STAGING=true but network=pubnet + PUBNET_ENABLED=false → blocks GATE4 pubnet flag', () => {
    const env = { ...fullClear(), ESCROW_OUROWN_PUBNET_ENABLED: 'false' };
    const r = ourOwnImplGate(env, 'pubnet', CONTRACT_ID);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some(s => /pubnet/i.test(s) && s.includes('GATE 4/4'))).toBe(true);
  });

  it('VALID PUBNET RELEASE: all gates + PUBNET_ENABLED=true → allowed=true reasons=[] (ZERO bypass)', () => {
    const env: Record<string, string> = {
      ESCROW_SECURITY_L2_PASSED: 'true',
      ESCROW_L1_SIGN_OFF_1: 'auditor1@trustgate.app',
      ESCROW_L1_SIGN_OFF_2: 'auditor2@trustgate.app',
      ESCROW_AUDIT_SHA256_1: HEX_64_A,
      ESCROW_AUDIT_SHA256_2: HEX_64_B,
      ESCROW_OUROWN_PUBNET_ENABLED: 'true',
    };
    const r = ourOwnImplGate(env, 'pubnet', CONTRACT_ID);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
