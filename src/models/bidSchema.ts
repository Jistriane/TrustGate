import { z } from 'zod';
import { parseUsdcDecimalToStroops } from '../utils/money';

export const createBidSignedSchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  executor: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'executor must be a valid Stellar public key'),
  amount: z
    .string()
    .min(1, 'amount is required')
    .refine((value) => {
      try {
        return parseUsdcDecimalToStroops(value) > 0n;
      } catch {
        return false;
      }
    }, 'amount must be a valid USDC decimal string'),
  collateral: z
    .string()
    .min(1, 'collateral is required')
    .refine((value) => {
      try {
        return parseUsdcDecimalToStroops(value) > 0n;
      } catch {
        return false;
      }
    }, 'collateral must be a valid USDC decimal string'),
});

export const createBidLocalSchema = createBidSignedSchema.extend({
  secret: z.string().regex(/^S[A-Z2-7]{55}$/, 'secret must be a valid Stellar secret key'),
});

export type CreateBidSignedInput = z.infer<typeof createBidSignedSchema>;
export type CreateBidLocalInput = z.infer<typeof createBidLocalSchema>;
