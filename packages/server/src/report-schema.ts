import { z } from 'zod';

/**
 * The public contract: what a report must look like (design doc, "Report contract").
 * Anything that doesn't match is rejected before it can touch a window (Problem 8: validation).
 */

// Letters, digits and _ . : - only. Rules out empty names, spaces and odd characters.
const name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'only letters, digits and _ . : - are allowed');

const pathCounts = z
  .object({
    requests: z.number().int().min(0).max(10_000_000),
    errors: z.number().int().min(0),
  })
  .strict()
  .refine((p) => p.errors <= p.requests, { message: 'errors cannot exceed requests' });

export const reportSchema = z
  .object({
    flag: name,
    environment: name,
    window_start: z.string().datetime({ offset: true }),
    on: pathCounts,
    off: pathCounts,
  })
  .strict();

export type Report = z.infer<typeof reportSchema>;
