import { existsSync, readFileSync, writeFileSync } from 'fs';

export function upsertEnvVar(envPath: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${line}\n`);
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  const updated = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\n*$/, '\n')}${line}\n`;

  writeFileSync(envPath, updated);
}
