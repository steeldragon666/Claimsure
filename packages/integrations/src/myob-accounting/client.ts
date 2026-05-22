import { withRetry } from '../runtime/retry.js';
import { MYOB_API_BASE, type MyobCompanyFile } from './types.js';

export type MyobAccountingClientOptions = {
  /** Decrypted MYOB access token. */
  access_token: string;
  /** MYOB developer key. Sent as x-myobapi-key. */
  api_key: string;
  /** Optional company-file auth values for secured company files. */
  company_file_username?: string;
  company_file_password?: string;
  /** Test override for the API base URL. */
  base_url?: string;
};

/**
 * Authenticated GET against the MYOB AccountRight API. `path` is relative to
 * the AccountRight root, for example `/` for company files or
 * `/{companyFileId}/Sale/Invoice/Item`.
 */
export async function myobAccountingGet(
  opts: MyobAccountingClientOptions,
  path: string,
  query?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${opts.base_url ?? MYOB_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.access_token}`,
    'x-myobapi-key': opts.api_key,
    'x-myobapi-version': 'v2',
    Accept: 'application/json',
    ...companyFileHeaders(opts),
    ...extraHeaders,
  };

  const res = await withRetry(() => fetch(url, { headers }));
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`myob accounting GET ${path}: ${res.status} ${errText}`);
  }
  return res.json();
}

export async function listCompanyFiles(
  opts: MyobAccountingClientOptions,
): Promise<MyobCompanyFile[]> {
  const data = (await myobAccountingGet(opts, '/')) as MyobCompanyFileWire[];
  return data.map((file) => ({
    id: file.Id,
    name: file.Name,
    uri: file.Uri,
    ...(file.ProductId !== undefined ? { product_id: file.ProductId } : {}),
  }));
}

type MyobCompanyFileWire = {
  Id: string;
  Name: string;
  Uri: string;
  ProductId?: string;
};

function companyFileHeaders(opts: MyobAccountingClientOptions): Record<string, string> {
  if (!opts.company_file_username && !opts.company_file_password) {
    return {};
  }

  return {
    'x-myobapi-cftoken': Buffer.from(
      `${opts.company_file_username ?? ''}:${opts.company_file_password ?? ''}`,
      'utf8',
    ).toString('base64'),
  };
}

