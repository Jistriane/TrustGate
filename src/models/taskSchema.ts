import { z } from 'zod';
import { parseUsdcDecimalToStroops } from '../utils/money';

export const createTaskSchema = z.object({
  requester: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'requester must be a valid Stellar public key'),
  reservePrice: z
    .string()
    .min(1, 'reservePrice is required')
    .refine((value) => {
      try {
        return parseUsdcDecimalToStroops(value) > 0n;
      } catch {
        return false;
      }
    }, 'reservePrice must be a valid USDC decimal string'),
  description: z.string().min(1, 'description is required'),
  deadline: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'deadline must be a valid date')
    .refine((value) => new Date(value).getTime() > Date.now(), 'deadline must be in the future'),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * `NETWORK=local` dev/CI-only request shape: the requester's secret is sent
 * directly so the server can sign the listing-fee transfer itself. On
 * testnet/pubnet, `POST /tasks` instead goes through the real MPP Charge
 * protocol gate (see `src/config/mppCharge.ts`) — no secret is ever sent.
 */
export const createTaskLocalRequestSchema = createTaskSchema.extend({
  secret: z.string().regex(/^S[A-Z2-7]{55}$/, 'secret must be a valid Stellar secret key'),
});

export type CreateTaskLocalRequest = z.infer<typeof createTaskLocalRequestSchema>;

export const completeTaskSignedRequestSchema = z.object({
  requester: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'requester must be a valid Stellar public key'),
});

export const completeTaskLocalRequestSchema = completeTaskSignedRequestSchema.extend({
  secret: z.string().regex(/^S[A-Z2-7]{55}$/, 'secret must be a valid Stellar secret key'),
});

export type CompleteTaskSignedRequest = z.infer<typeof completeTaskSignedRequestSchema>;
export type CompleteTaskLocalRequest = z.infer<typeof completeTaskLocalRequestSchema>;
