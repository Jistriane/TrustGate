import { z } from 'zod';

export const createTaskSchema = z.object({
  requester: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'requester must be a valid Stellar public key'),
  reservePrice: z.number().positive('reservePrice must be greater than 0'),
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

export const completeTaskRequestSchema = z.object({
  requester: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'requester must be a valid Stellar public key'),
  secret: z.string().regex(/^S[A-Z2-7]{55}$/, 'secret must be a valid Stellar secret key'),
});

export type CompleteTaskRequest = z.infer<typeof completeTaskRequestSchema>;
