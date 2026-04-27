import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subjectTenantEmployee } from './subject_tenant_employee.js';

/**
 * Long-lived refresh-token state per mobile device.
 *
 * Created on magic-link redemption (design doc §3.1) and rotated on each
 * refresh (design doc §3.2). 90-day sliding window: each successful refresh
 * extends `expires_at` and bumps `last_refreshed_at`.
 *
 * NOT directly RLS-scoped — sessions are always accessed via `employee_id`,
 * and `subject_tenant_employee` IS RLS-scoped, so the join enforces tenant
 * isolation transitively. Direct queries by `refresh_token_hash` happen
 * during refresh BEFORE any tenant context is set (the hash is the secret).
 *
 * `device_fingerprint` is a stable per-device identifier (Expo
 * `Application.androidId` / iOS keychain UUID) — stored at first login,
 * verified on each refresh. Mismatched fingerprint → revoke.
 *
 * `push_token` carries the Expo Push token for A12-A13 (push notifications
 * for prompts + signing requests). Updated whenever the device reports a
 * new token via /v1/push-token.
 *
 * Naming convention: camelCase TS / snake_case SQL.
 */
export const mobileSession = pgTable('mobile_session', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => subjectTenantEmployee.id),
  deviceFingerprint: text('device_fingerprint').notNull(),
  // hex SHA-256 of the raw refresh token; rotated on each refresh.
  refreshTokenHash: text('refresh_token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Expo Push token for A12-A13 push notifications. Nullable — populated
  // after first successful registerForPushNotificationsAsync() call.
  pushToken: text('push_token'),
});
