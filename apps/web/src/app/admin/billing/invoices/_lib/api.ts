import { apiFetch } from '@/lib/api';

/**
 * Invoice summary returned by GET /v1/invoices (P9.2.6).
 *
 * All monetary amounts are in the smallest currency unit (cents for AUD).
 */
export interface InvoiceSummary {
  id: string;
  created: number;
  status: string;
  currency: string;
  /** Subtotal before 10% AU GST. */
  subtotal_excl_tax: number;
  /** GST amount (10%). */
  tax_amount: number;
  /** Grand total including GST. */
  total: number;
  /** Stripe-hosted PDF download URL, null for draft invoices. */
  invoice_pdf: string | null;
}

export async function listInvoices(): Promise<InvoiceSummary[]> {
  const body = await apiFetch<{ invoices: InvoiceSummary[] }>('/v1/invoices');
  return body.invoices;
}
