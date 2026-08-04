import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { upsertEnvVar } from './envFile';

describe('upsertEnvVar', () => {
  function tempEnvPath(): string {
    return join(mkdtempSync(join(tmpdir(), 'envfile-test-')), '.env');
  }

  it('creates the file when it does not exist', () => {
    const envPath = tempEnvPath();
    upsertEnvVar(envPath, 'FOO', 'bar');
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=bar\n');
  });

  it('appends a new key to an existing file', () => {
    const envPath = tempEnvPath();
    upsertEnvVar(envPath, 'FOO', 'bar');
    upsertEnvVar(envPath, 'BAZ', 'qux');
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=bar\nBAZ=qux\n');
  });

  it('replaces an existing key in place', () => {
    const envPath = tempEnvPath();
    upsertEnvVar(envPath, 'FOO', 'bar');
    upsertEnvVar(envPath, 'FOO', 'updated');
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=updated\n');
  });
});
