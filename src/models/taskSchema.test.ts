import { createTaskSchema } from './taskSchema';

const VALID_REQUESTER = 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO';

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

describe('createTaskSchema', () => {
  it('accepts a valid task payload', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: 100,
      description: 'Do something useful',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing required fields', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string requester', () => {
    const result = createTaskSchema.safeParse({
      requester: 12345,
      reservePrice: 100,
      description: 'Do something useful',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a requester that is not a valid Stellar public key', () => {
    const result = createTaskSchema.safeParse({
      requester: 'not-a-valid-key',
      reservePrice: 100,
      description: 'Do something useful',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric reservePrice', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: '100',
      description: 'Do something useful',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative reservePrice', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: 0,
      description: 'Do something useful',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty description', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: 100,
      description: '',
      deadline: futureDate(1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid deadline string', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: 100,
      description: 'Do something useful',
      deadline: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a deadline in the past', () => {
    const result = createTaskSchema.safeParse({
      requester: VALID_REQUESTER,
      reservePrice: 100,
      description: 'Do something useful',
      deadline: futureDate(-1),
    });
    expect(result.success).toBe(false);
  });
});
