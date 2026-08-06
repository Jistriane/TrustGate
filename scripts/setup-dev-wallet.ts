/*
 * scripts/setup-dev-wallet.ts — TrustGate Onboarding Dev Wallet v1.0 (Item 7 / P3-D)
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/setup-dev-wallet.ts --network testnet --out ~/.trustgate/dev-wallet-v1.enc
 *
 * What it does:
 *   1. Generates random Ed25519 keypair (32-byte seed).
 *   2. If NETWORK=testnet — requests 10,000 XLM from Friendbot.
 *      In local/standalone tells user how to fund via cURL.
 *   3. Derives AES-256-GCM key via scrypt (N=32768, r=8, p=1).
 *   4. Persists encrypted at $HOME/.trustgate/dev-wallet-v1.enc (0600 permissions).
 *   5. Prints secure instructions to fill .env without exposing SK... in history.
 *
 * Exit codes:
 *   0  OK
 *   77 skipped (file already exists without --force, user aborted)
 *   2 fatal error
 */

import { Keypair } from '@stellar/stellar-sdk';
import { createCipheriv, scryptSync, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { homedir } from 'os';

type WalletCiphertext = {
  version: 1;
  kdf: 'scrypt';
  scryptParams: { N: number; r: number; p: number; saltB64: string; dklen: number };
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
  pubKeyG: string;
  createdAtISO: string;
};

const DEFAULTS = {
  N: 32768,
  r: 8,
  p: 1,
  dklen: 32,
};

const logInfo = (m: string) => process.stdout.write('[info ] ' + m + '\n');
const logWarn = (m: string) => process.stderr.write('\x1b[33m[warn ] ' + m + '\x1b[0m\n');
const logErr  = (m: string) => process.stderr.write('\x1b[31m[error] ' + m + '\x1b[0m\n');
const logOk   = (m: string) => process.stdout.write('\x1b[32m[ ok ] ' + m + '\x1b[0m\n');

async function promptPassword(rl: readline.Interface): Promise<string> {
  const p1 = await rl.question('Digite a senha de criptografia (min 8 chars): ');
  const p2 = await rl.question('Confirme a senha novamente: ');
  if (p1.length < 8) throw new Error('Senha muito curta (min 8 chars).');
  if (p1 !== p2) throw new Error('Senhas nao coincidem.');
  return p1;
}

function encryptAesGcm(plaintextBuf: Buffer, password: string): WalletCiphertext {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const key  = scryptSync(password, salt, DEFAULTS.dklen, {
    N: DEFAULTS.N, r: DEFAULTS.r, p: DEFAULTS.p,
    maxmem: 128 * DEFAULTS.N * DEFAULTS.r * 2,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: 'scrypt',
    scryptParams: {
      N: DEFAULTS.N, r: DEFAULTS.r, p: DEFAULTS.p,
      saltB64: salt.toString('base64'),
      dklen: DEFAULTS.dklen,
    },
    ivB64: iv.toString('base64'),
    tagB64: tag.toString('base64'),
    ciphertextB64: ct.toString('base64'),
    pubKeyG: '',
    createdAtISO: new Date().toISOString(),
  };
}

async function main(argv: string[]): Promise<number> {
  const idxNet = argv.indexOf('--network');
  const network = idxNet >= 0 ? argv[idxNet + 1] || (process.env.NETWORK ?? 'testnet') : (process.env.NETWORK ?? 'testnet');
  const idxOut = argv.indexOf('--out');
  const outPath = idxOut >= 0 ? argv[idxOut + 1] : path.join(homedir(), '.trustgate', 'dev-wallet-v1.enc');
  const force = argv.includes('--force');
  const noFund = argv.includes('--no-fund');

  const home = homedir();
  const resolvedOut = outPath.startsWith('~') ? path.join(home, outPath.slice(1)) : outPath;

  logInfo('Network: ' + network);
  logInfo('Output : ' + resolvedOut);

  if (fs.existsSync(resolvedOut) && !force) {
    logWarn('Arquivo ja existe em "' + resolvedOut + '". Use --force para sobrescrever.');
    return 77;
  }

  const kp = Keypair.random();
  logOk('Gerada nova keypair:');
  logOk('   PK = ' + kp.publicKey());
  logWarn('   (NUNCA compartilhe a chave secreta SK... em chat ou commits!)');

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pwd = await promptPassword(rl);
    const plain = Buffer.from(JSON.stringify({
      publicKey: kp.publicKey(),
      secretKey: kp.secret(),
      createdAt: new Date().toISOString(),
      comment: 'TrustGate dev-wallet v1 — NAO commitar.',
    }, null, 2), 'utf8');
    const ct = encryptAesGcm(plain, pwd);
    ct.pubKeyG = kp.publicKey();

    fs.writeFileSync(resolvedOut, JSON.stringify(ct, null, 2) + '\n', {
      encoding: 'utf8', mode: 0o600,
    });
    logOk('Arquivo criptografado salvo em ' + resolvedOut + ' (permissoes 0600)');

    if (!noFund) {
      if (network === 'testnet') {
        logInfo('Solicitando 10.000 XLM via Friendbot da Testnet...');
        try {
          const resp = await fetch('https://friendbot.stellar.org?addr=' + encodeURIComponent(kp.publicKey()));
          if (!resp.ok) {
            logWarn('Friendbot HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
          } else {
            logOk('10.000 XLM creditados. Consultar:');
            logOk('   https://stellar.expert/explorer/testnet/account/' + kp.publicKey());
          }
        } catch (e) {
          logWarn('Friendbot falhou (rede?): ' + (e as Error).message);
        }
      } else if (network === 'local' || network === 'standalone') {
        logInfo('NETWORK=local/standalone: funding via friendbot dockerizado ou curl:');
        logWarn('   curl http://localhost:8000/friendbot?addr=' + kp.publicKey());
      } else {
        logWarn('NETWORK=' + network + ': funding deve ser provisionado manualmente.');
      }
    }

    logOk('');
    logOk('=== PROXIMOS PASSOS ===');
    logOk('1. Copie a chave publica para MARKETPLACE_WALLET:');
    console.log('   export MARKETPLACE_WALLET=' + kp.publicKey());
    logOk('2. Para setar MARKETPLACE_SECRET_KEY sem expor no shell history:');
    console.log('   read -s _sk && export MARKETPLACE_SECRET_KEY="$_sk" ; unset _sk');
    logOk('3. Para visualizar a SK.. no futuro (use com cuidado):');
    console.log('   npx ts-node scripts/decrypt-wallet.ts ' + resolvedOut + ' --print-secret');
    logOk('4. Cole no seu .env (MARKETPLACE_SECRET_KEY NAO deve existir no .env.example):');
    console.log('   MARKETPLACE_WALLET=' + kp.publicKey());
    console.log('   # MARKETPLACE_SECRET_KEY=...');

    return 0;
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2))
  .then(rc => process.exit(rc))
  .catch(err => {
    logErr((err as Error).message);
    if (process.env.DEBUG && (err as Error).stack) console.error((err as Error).stack);
    process.exit(2);
  });

export type { WalletCiphertext };
