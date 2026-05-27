/**
 * MYOB AccountRight accounting integration scaffolding.
 *
 * The marketing material names MYOB beside Xero as a supported accounting
 * source. This module establishes the provider contract ArchiveOne needs before
 * resource-specific expenditure sync helpers are layered on top: OAuth 2.0,
 * company-file selection, and authenticated AccountRight API calls.
 */

export type MyobAccountingAuthConfig = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

export const MYOB_OAUTH_AUTHORIZE_URL = 'https://secure.myob.com/oauth2/account/authorize';
export const MYOB_OAUTH_TOKEN_URL = 'https://secure.myob.com/oauth2/v1/authorize';
export const MYOB_API_BASE = 'https://api.myob.com/accountright';

export const MYOB_ACCOUNTING_SCOPES = ['CompanyFile'] as const;

/**
 * Provider key written to `integration_connection.provider`.
 */
export const MYOB_ACCOUNTING_PROVIDER = 'myob_accounting' as const;

/**
 * Company files are the MYOB equivalent of Xero tenant connections. The
 * selected company file URI is persisted as `external_account_id` and passed to
 * downstream sync helpers.
 */
export type MyobCompanyFile = {
  id: string;
  name: string;
  uri: string;
  product_id?: string;
};

