import { Keypair } from '@stellar/stellar-sdk';

export function generateKeypair(): Keypair {
  return Keypair.random();
}

export function keypairFromSecret(secret: string): Keypair {
  return Keypair.fromSecret(secret);
}

export function loadKeypairFromEnv(envVar: string): Keypair {
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`Missing environment variable: ${envVar}`);
  }
  return keypairFromSecret(secret);
}
