/*
 * scripts/decrypt-wallet.ts — TrustGate dev-wallet decrypt helper
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/decrypt-wallet.ts <path> [--print-secret]
 *
 * Examples:
 *   npx ts-node scripts/decrypt-wallet.ts ~/.trustgate/dev-wallet-v1.enc
 *   npx ts-node scripts/decrypt-wallet.ts ~/.trustgate/dev-wallet-v1.enc --print-secret
 *
 * Without --print-secret: displays PK and metadata.
 * With --print-secret: displays SK.. and secure export instruction.
 */

import { createDecipheriv, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as readline from 'readline/promises';
import { homedir } from 'os';
import * as path from 'path';

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

const logErr  = (m: string) => process.stderr.write('\x1b[31m' + m + '\x1b[0m\n');
const logWarn = (m: string) => process.stderr.write('\x1b[33m' + m + '\x1b[0m\n');
const logOk   = (m: string) => process.stdout.write('\x1b[32m' + m + '\x1b[0m\n');

async function main(argv: string[]) {
  if (argv.length < 1 || argv[0] === '--help') {
    console.error('Uso: npx ts-node --transpile-only scripts/decrypt-wallet.ts <path> [--print-secret]');
    process.exit(2);
  }
  const inpArg = argv[0];
  const inp = inpArg.startsWith('~') ? path.join(homedir(), inpArg.slice(1)) : inpArg;
  const printSecret = argv.includes('--print-secret');

  if (!fs.existsSync(inp)) {
    logErr('Arquivo nao existe: ' + inp);
    process.exit(2);
  }

  let data: WalletCiphertext;
  try {
    data = JSON.parse(fs.readFileSync(inp, 'utf8')) as WalletCiphertext;
  } catch (e) {
    logErr('Arquivo corrompido (JSON invalido): ' + (e as Error).message);
    process.exit(2);
  }
  if (data.version !== 1 || data.kdf !== 'scrypt') {
    logErr('Versao/kdf incompativel: esperado v1/scrypt, recebido v' + data.version + '/' + data.kdf);
    process.exit(2);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pwd = await rl.question('Senha de criptografia: ');
    const salt = Buffer.from(data.scryptParams.saltB64, 'base64');
    const key = scryptSync(pwd, salt, data.scryptParams.dklen, {
      N: data.scryptParams.N,
      r: data.scryptParams.r,
      p: data.scryptParams.p,
      maxmem: 128 * data.scryptParams.N * data.scryptParams.r * 2,
    });
    const iv  = Buffer.from(data.ivB64, 'base64');
    const tag = Buffer.from(data.tagB64, 'base64');
    const ct  = Buffer.from(data.ciphertextB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plainBuf: Buffer;
    try {
      plainBuf = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (e) {
      logErr('Falha ao decifrar: senha incorreta OU arquivo corrompido (auth tag invalida).');
      process.exit(2);
    }
    const json = JSON.parse(plainBuf.toString('utf8'));
    logOk('=== Descriptografado com sucesso ===');
    console.log('publicKey = ' + json.publicKey);
    console.log('criado em = ' + data.createdAtISO);
    if (printSecret) {
      logWarn('ATENCAO: exibindo chave secreta abaixo. Feche este terminal depois.');
      console.log('secretKey = ' + json.secretKey);
      console.log('');
      console.log('Shell seguro (sem sujar history):');
      console.log('  read -s _sk && export MARKETPLACE_SECRET_KEY="$_sk" ; unset _sk');
    } else {
      console.log('');
      console.log('Use --print-secret para exibir a chave secreta.');
    }
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2)).catch(err => {
  logErr('Erro: ' + (err as Error).message);
  if (process.env.DEBUG && (err as Error).stack) console.error((err as Error).stack);
  process.exit(2);
});
