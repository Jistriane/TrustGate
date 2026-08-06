/**
 * src/contracts/bindings/escrow/src/types.ts
 *
 * TypeScript types 1:1 mapped to the #[contracttype] and #[contracterror]
 * declarations of the Rust Escrow Option C contract at contracts/escrow/src/lib.rs.
 *
 * ⚠️ DO NOT edit manually after regenerating with `soroban contract bindings typescript`
 *    (P0-5). This file was crafted MANUALLY because the Rust 1.84.0 toolchain is
 *    not yet installed (Item 3 scripts/contract-security-check.sh RC=77).
 *    Once the toolchain is installed, simply replace this file + client.ts with
 *    the auto-generated bindings — the method signatures are identical.
 */

export interface EscrowState {
  task_id_hash: string;
  executor: string;
  requester: string;
  release_signer: string;
  collateral: bigint;
  released: bigint;
  created_at_ledger: number;
  status: number;
}

export const EscrowStatus = {
  LOCKED: 0,
  RELEASED: 1,
  CONFISCATED: 2,
  TIMED_OUT: 3,
} as const;
export type EscrowStatusId = (typeof EscrowStatus)[keyof typeof EscrowStatus];

export interface EscrowError {
  message: string;
}
export const EscrowError = {
  1:  { message: "EscrowNotFound" },
  2:  { message: "NotExecutor" },
  3:  { message: "NotReleaseSigner" },
  4:  { message: "NotRequester" },
  5:  { message: "AlreadyReleased" },
  6:  { message: "AlreadyConfiscated" },
  7:  { message: "NotLocked" },
  8:  { message: "InsufficientCollateral" },
  9:  { message: "ShareBpInvalid" },
  10: { message: "ClaimTooEarly" },
  11: { message: "InvalidNonce" },
  12: { message: "ZeroCollateral" },
  13: { message: "MarketplaceNotAuthorized" },
  14: { message: "ShareBpBelowMinimum" },
  15: { message: "AlreadyInitialized" },
  16: { message: "ContractPaused" },
  17: { message: "NotPauser" },
  18: { message: "ReleaseAmountExceedsRemaining" },
  19: { message: "ReleaseAmountZero" },
  20: { message: "NotInitialized" },
  21: { message: "AlreadyFullyReleased" },
} as const;
