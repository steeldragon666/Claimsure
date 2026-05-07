'use client';
import { useQuery } from '@tanstack/react-query';
import { AuthGuard } from '@/components/auth-guard';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listInvoices, type InvoiceSummary } from './_lib/api';

/**
 * /admin/billing/invoices — Invoice history page (P9.2.6).
 *
 * Fetches invoices from GET /v1/invoices (which proxies to Stripe).
 * Displays date, subtotal excl. GST, GST (10%), total, status, and
 * a PDF download link per invoice.
 *
 * AU GST note: All amounts are in AUD cents. The page formats them
 * as AUD currency and shows the GST breakdown per invoice (P9.2.5).
 */

function formatAUD(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}

function formatDate(unixTs: number): string {
  return new Date(unixTs * 1000).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function statusClassName(status: string): string {
  switch (status) {
    case 'paid':
      return 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-green-100 text-green-800';
    case 'open':
      return 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-yellow-100 text-yellow-800';
    case 'void':
    case 'uncollectible':
      return 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-800';
    default:
      return 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-gray-100 text-gray-700';
  }
}

function InvoiceTable() {
  const {
    data: invoices = [],
    isLoading,
    error,
  } = useQuery<InvoiceSummary[]>({
    queryKey: ['invoices'],
    queryFn: listInvoices,
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading invoices…</p>;
  }

  if (error) {
    return <p className="text-destructive text-sm">Failed to load invoices. Please try again.</p>;
  }

  if (invoices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No invoices found. Invoices appear here once your subscription is active and your first
        billing cycle completes.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead className="text-right">Subtotal (excl. GST)</TableHead>
          <TableHead className="text-right">GST (10%)</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((inv) => (
          <TableRow key={inv.id}>
            <TableCell>{formatDate(inv.created)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatAUD(inv.subtotal_excl_tax)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatAUD(inv.tax_amount)}</TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatAUD(inv.total)}
            </TableCell>
            <TableCell>
              <span className={statusClassName(inv.status)}>{inv.status}</span>
            </TableCell>
            <TableCell>
              {inv.invoice_pdf ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={inv.invoice_pdf} target="_blank" rel="noopener noreferrer">
                    Download PDF
                  </a>
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function InvoicesPage() {
  return (
    <AuthGuard>
      <main className="container mx-auto py-8 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Invoice history</h1>
          <p className="text-muted-foreground mt-2">
            All invoices include 10% Australian GST. ABN: 12 345 678 901.
          </p>
        </div>
        <InvoiceTable />
      </main>
    </AuthGuard>
  );
}
