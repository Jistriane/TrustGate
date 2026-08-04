import { z } from 'zod';

export const createBidSchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  executor: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'executor must be a valid Stellar public key'),
  secret: z.string().regex(/^S[A-Z2-7]{55}$/, 'secret must be a valid Stellar secret key'),
  amount: z.number().positive('amount must be greater than 0'),
  collateral: z.number().positive('collateral must be greater than 0'),
});

export type CreateBidInput = z.infer<typeof createBidSchema>;
