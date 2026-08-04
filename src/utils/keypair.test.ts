import { generateKeypair, keypairFromSecret, loadKeypairFromEnv } from './keypair';

describe('keypair', () => {
  it('generates a random keypair with a valid public/secret pair', () => {
    const kp = generateKeypair();
    expect(kp.publicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    expect(kp.secret()).toMatch(/^S[A-Z0-9]{55}$/);
  });

  it('rebuilds the same keypair from its secret', () => {
    const kp = generateKeypair();
    const rebuilt = keypairFromSecret(kp.secret());
    expect(rebuilt.publicKey()).toBe(kp.publicKey());
  });

  it('loads a keypair from an environment variable', () => {
    const kp = generateKeypair();
    process.env.TEST_ADMIN_SECRET = kp.secret();
    const loaded = loadKeypairFromEnv('TEST_ADMIN_SECRET');
    expect(loaded.publicKey()).toBe(kp.publicKey());
    delete process.env.TEST_ADMIN_SECRET;
  });

  it('throws when the environment variable is missing', () => {
    delete process.env.MISSING_SECRET;
    expect(() => loadKeypairFromEnv('MISSING_SECRET')).toThrow();
  });
});
