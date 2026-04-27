'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CustomDomainStatusValue } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  checkCustomDomain,
  disconnectCustomDomain,
  setCustomDomain,
  type SetCustomDomainResponse,
} from '../_lib/api';

/**
 * Custom domain wizard (T-C6).
 *
 * Three render branches keyed off the persisted lifecycle state:
 *
 *   - `unconfigured`: input + "Connect" button → POST /custom-domain.
 *     Server flips status to `cname_pending` and the response carries
 *     the CNAME record the firm has to publish.
 *
 *   - `cname_pending` / `cert_pending`: shows the CNAME instructions
 *     plus a "Refresh" button. The refresh action wires up in T-C7
 *     once the state machine job lands; today the button is a no-op
 *     placeholder.
 *
 *   - `active`: green confirmation + "Disconnect" button. Disconnect
 *     resets the row to `unconfigured` and the CTA flips back to the
 *     input form.
 *
 * The CNAME record we just received from POST /custom-domain is held
 * in local component state (`recentCname`) so the user sees the exact
 * record their request returned even though the persisted row only has
 * `custom_domain` (not the CNAME target). On a hard reload, status is
 * still `cname_pending` but `recentCname` is null — we fall back to a
 * "your domain is connecting" message and a contact-support link.
 */

const FQDN_REGEX = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

export function CustomDomainWizard({
  currentDomain,
  currentStatus,
}: {
  currentDomain: string | null;
  currentStatus: CustomDomainStatusValue;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [domainInput, setDomainInput] = useState('');
  const [recentCname, setRecentCname] = useState<SetCustomDomainResponse | null>(null);

  const connect = useMutation({
    mutationFn: (custom_domain: string) => setCustomDomain(custom_domain),
    onSuccess: (res) => {
      setRecentCname(res);
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Domain registered — publish the CNAME to verify' });
    },
    onError: (e) =>
      toast({
        title: 'Connect failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectCustomDomain(),
    onSuccess: () => {
      setRecentCname(null);
      setDomainInput('');
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Custom domain disconnected' });
    },
    onError: (e) =>
      toast({
        title: 'Disconnect failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  const refresh = useMutation({
    mutationFn: () => checkCustomDomain(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      if (res.transitioned) {
        toast({ title: `Status advanced to ${res.status}` });
      } else {
        toast({
          title: 'No change yet',
          description:
            res.status === 'cname_pending'
              ? 'Waiting for DNS propagation. Try again in a few minutes.'
              : `Current status: ${res.status}`,
        });
      }
    },
    onError: (e) =>
      toast({
        title: 'Refresh failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  if (currentStatus === 'active' && currentDomain) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-emerald-700">
          <span aria-hidden="true">✓</span> Active — your platform is live at{' '}
          <a
            href={`https://${currentDomain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            https://{currentDomain}
          </a>
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending ? 'Disconnecting…' : 'Disconnect domain'}
        </Button>
      </div>
    );
  }

  if (currentStatus === 'failed' && currentDomain) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600">
          <span aria-hidden="true">✗</span> Domain verification failed for{' '}
          <code>{currentDomain}</code>. Disconnect to try a different domain.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending ? 'Disconnecting…' : 'Disconnect domain'}
        </Button>
      </div>
    );
  }

  // cname_pending / cert_pending — show instructions if we have them.
  if ((currentStatus === 'cname_pending' || currentStatus === 'cert_pending') && currentDomain) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-amber-700">
          <span aria-hidden="true">⏳</span> Pending DNS verification for{' '}
          <code>{currentDomain}</code>
        </p>
        {recentCname && <CnameInstructions data={recentCname} />}
        {!recentCname && (
          <p className="text-xs text-muted-foreground">
            Once your DNS provider publishes the CNAME, we&apos;ll detect it automatically and issue
            a certificate (typically within 24 hours). Use <strong>Refresh</strong> to check status.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect domain'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? 'Checking…' : 'Refresh'}
          </Button>
        </div>
      </div>
    );
  }

  // unconfigured (or stale state) — show the input form.
  const inputValid = FQDN_REGEX.test(domainInput);

  return (
    <div className="space-y-3">
      <Input
        type="text"
        value={domainInput}
        onChange={(e) => setDomainInput(e.target.value.toLowerCase())}
        placeholder="platform.acmeconsulting.com.au"
        className="font-mono max-w-md"
        autoComplete="off"
      />
      {domainInput !== '' && !inputValid && (
        <p className="text-sm text-red-600" aria-live="polite">
          <span aria-hidden="true">✗</span> Must be a lowercase FQDN like platform.acme.com.au
        </p>
      )}
      <Button
        type="button"
        onClick={() => connect.mutate(domainInput)}
        disabled={!inputValid || connect.isPending}
      >
        {connect.isPending ? 'Registering…' : 'Connect domain'}
      </Button>
      {recentCname && <CnameInstructions data={recentCname} />}
    </div>
  );
}

function CnameInstructions({ data }: { data: SetCustomDomainResponse }) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm space-y-2">
      <p className="font-medium">Publish this CNAME record to verify ownership:</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <dt className="font-medium">Name</dt>
        <dd>{data.cname_record.name}</dd>
        <dt className="font-medium">Type</dt>
        <dd>{data.cname_record.type}</dd>
        <dt className="font-medium">Value</dt>
        <dd>{data.cname_record.value}</dd>
      </dl>
      <p className="text-xs text-muted-foreground whitespace-pre-line">{data.instructions}</p>
    </div>
  );
}
