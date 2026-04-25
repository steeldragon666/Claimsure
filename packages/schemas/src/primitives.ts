import { z } from 'zod';

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const Sha256Hash = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars');
export type Sha256Hash = z.infer<typeof Sha256Hash>;

export const Iso8601 = z.string().datetime({ offset: true });
export type Iso8601 = z.infer<typeof Iso8601>;
