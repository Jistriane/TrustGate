/**
 * src/contracts/bindings/escrow/src/client.ts
 *
 * TypeScript client for Escrow contract (Option C / ADR 0002 P2.4).
 *
 * ⚠️ MANUAL VERSION (until Rust 1.84.0 toolchain installed in P0-5).
 *   To minimize typing errors in root tsconfig (moduleResolution: node),
 *   we use `any` throughout the public interface. The auto-generated bindings from
 *   `soroban contract bindings typescript` replace THIS ENTIRE file
 *   when they are ready — the signature (method/arg names) is identical.
 *
 * Updated 2026-08-06 V14: initialize args {token, release_signer, marketplace}
 *   — field `pauser` was REMOVED because initialize Saves DataKey::Pauser =
 *   release_signer by default (lib.rs initialize). 3rd arg NOW is Marketplace
 *   authorized to call confiscate(). Aligned with lib.rs fn initialize(token,
 *   release_signer, marketplace) from contracts/escrow/src/lib.rs L217.
 */

import { EscrowState, EscrowError } from './types.js';
// @ts-expect-error stellar-sdk exports subpath contract via nodenext exports,
// root tsconfig uses moduleResolution node and cannot resolve. Works at runtime.
import * as ContractSdk from '@stellar/stellar-sdk/contract';

const SPEC_PLACEHOLDER: string[] = [
  'AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABAAAAAEAAAAAAAAABkVzY3JvdwAAAAEAAAPoAAAAIgAAAAAAAAAABlBhdXNlcgAAAAAAAAAAABNJc1BhdXNlZAAAAAAsAAAAABUb2tlbgAAAAAAAAAAAAAAD1JlbGVhc2VTaWduZXIAAAAQAAAAAAAAAAtNYXJrZXRwbGFjZQAA',
];

export interface Client {
  initialize(args: { token: string | any; release_signer: string | any; marketplace: string | any }, options?: any): Promise<any>;
  create_escrow(args: Record<string, unknown>, options?: any): Promise<any>;
  release_milestone(args: { escrow_id: Buffer | Uint8Array | string; amount: bigint | number }, options?: any): Promise<any>;
  confiscate(args: Record<string, unknown>, options?: any): Promise<any>;
  claim_timeout(args: { escrow_id: Buffer | Uint8Array | string }, options?: any): Promise<any>;
  get_escrow(args: Record<string, unknown>, options?: any): Promise<any>;
  pause(args?: Record<string, unknown>, options?: any): Promise<any>;
  unpause(args?: Record<string, unknown>, options?: any): Promise<any>;
  is_paused(args?: Record<string, unknown>, options?: any): Promise<any>;
  transfer_pauser_ownership(args: { new_pauser: string | any }, options?: any): Promise<any>;
  __version(options?: any): Promise<number>;
}

export class Client extends (ContractSdk as any).ContractClient {
  constructor(public readonly options: any) {
    super(new (ContractSdk as any).Spec(SPEC_PLACEHOLDER), options);
  }
  static deploy(options: any): Promise<any> {
    return (ContractSdk as any).ContractClient.deploy(null, options);
  }
  public readonly fromJSON: Record<string, (x: any) => any> = {};
}

export type { EscrowState, EscrowError };
