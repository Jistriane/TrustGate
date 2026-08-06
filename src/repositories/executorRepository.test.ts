import { ExecutorRepository, ExecutorRecord } from './executorRepository';

function makeRec(overrides: Partial<ExecutorRecord> = {}): ExecutorRecord {
  return {
    publicKey: 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55),
    metadataUri: 'https://example.com/executor-meta.json',
    registeredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ExecutorRepository (InMemoryExecutorRepository)', () => {
  it('save + findByPublicKey returns same saved record', async () => {
    const repo = new ExecutorRepository();
    const r = makeRec({ publicKey: 'GEXECUTOR1' + 'A'.repeat(46) });
    await repo.save(r);
    await expect(repo.findByPublicKey(r.publicKey)).resolves.toEqual(r);
  });

  it('findByPublicKey returns undefined for unregistered key', async () => {
    const repo = new ExecutorRepository();
    await expect(repo.findByPublicKey('GNOTEXIST' + 'A'.repeat(45))).resolves.toBeUndefined();
  });

  it('list returns all saved executors in Map order', async () => {
    const repo = new ExecutorRepository();
    const r1 = makeRec({ publicKey: 'GAAA' + 'B'.repeat(52) });
    const r2 = makeRec({ publicKey: 'GBBB' + 'B'.repeat(52) });
    await repo.save(r1);
    await repo.save(r2);
    const all = await repo.list();
    expect(all.length).toBe(2);
    expect(all.map((e) => e.publicKey).sort()).toEqual([r1.publicKey, r2.publicKey].sort());
  });

  it('save overwrites same publicKey (idempotency)', async () => {
    const repo = new ExecutorRepository();
    const pk = 'GDEDUP' + 'X'.repeat(51);
    const v1 = makeRec({ publicKey: pk, metadataUri: 'v1.json' });
    const v2 = makeRec({ publicKey: pk, metadataUri: 'v2.json' });
    await repo.save(v1);
    await repo.save(v2);
    const got = await repo.findByPublicKey(pk);
    expect(got?.metadataUri).toBe('v2.json');
    const l = await repo.list();
    expect(l.length).toBe(1);
  });
});
