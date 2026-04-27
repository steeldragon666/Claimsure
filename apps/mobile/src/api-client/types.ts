/**
 * Re-export the API contract types the mobile app consumes.
 *
 * Keep this file the single import surface for "the shape coming back
 * from /v1/*" — screens and stores import from here, not directly from
 * @cpa/schemas. That way swapping the wire format (or adding a thin
 * mobile-side adapter type) is a one-file change.
 */
export type {
  Employee,
  BrandConfig,
  MagicLinkRedeemBody,
  MagicLinkRedeemResponse,
  MagicLinkRedeemBrand,
  RefreshTokenBody,
  RefreshTokenResponse,
} from '@cpa/schemas';
