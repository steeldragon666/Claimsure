'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DkimStatusValue } from '@cpa/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { checkEmailSender, setEmailSender, type SetEmailSenderResponse } from '../_lib/api';

/**
 * Email sender / DKIM wizard (T-C8).
 *
 * Branches off `email_sender_dkim_status`:
 *   - unconfigured: input form for the sender domain.
 *   - pending: TXT-record instructions + Verify DNS button (C9).
 *   - verified: green confirmation, no further action.
 *   - failed: red error + the option to disconnect / retry. (Surfaces
 *     `unconfigured` UI today since real DKIM lookups arrive in C9.)
 *
 * Like the custom-domain wizard, we hold the most-recent DKIM record
 * payload in local state — the persisted row only carries the domain +
 * status, not the tokens, so refreshing the page loses them. Real
 * impl will persist tokens in a `dkim_tokens jsonb` column or fetch
 * from SES on every render.
 */

const FQDN_REGEX = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

export function EmailSenderWizard({
  currentDomain,
  currentStatus,
}: {
  currentDomain: string | null;
  currentStatus: DkimStatusValue;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [domainInput, setDomainInput] = useState('');
  const [recentResponse, setRecentResponse] = useState<SetEmailSenderResponse | null>(null);

  const setSender = useMutation({
    mutationFn: (email_sender_domain: string) => setEmailSender(email_sender_domain),
    onSuccess: (res) => {
      setRecentResponse(res);
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Sender domain registered — publish the DKIM TXT records to verify' });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  const verify = useMutation({
    mutationFn: () => checkEmailSender(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      if (res.transitioned) {
        toast({ title: `DKIM ${res.status}` });
      } else {
        toast({
          title: 'No change yet',
          description:
            res.status === 'pending'
              ? 'TXT records not yet published. DNS can take up to 24 hours.'
              : `Current status: ${res.status}`,
        });
      }
    },
    onError: (e) =>
      toast({
        title: 'Verify failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  if (currentStatus === 'verified' && currentDomain) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-emerald-700">
          <span aria-hidden="true">✓</span> Verified — outbound email sends from{' '}
          <code>{currentDomain}</code>
        </p>
        <p className="text-xs text-muted-foreground">
          To switch to a different sender domain, register a new one below.
        </p>
        <SenderInput
          domainInput={domainInput}
          setDomainInput={setDomainInput}
          onSave={() => setSender.mutate(domainInput)}
          isPending={setSender.isPending}
        />
        {recentResponse && <DkimInstructions data={recentResponse} />}
      </div>
    );
  }

  if (currentStatus === 'pending' && currentDomain) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-amber-700">
          <span aria-hidden="true">⏳</span> Pending DKIM verification for{' '}
          <code>{currentDomain}</code>
        </p>
        {recentResponse && <DkimInstructions data={recentResponse} />}
        {!recentResponse && (
          <p className="text-xs text-muted-foreground">
            Once your DNS provider publishes the TXT records, click <strong>Verify DNS</strong>
            below to check propagation. DNS changes can take up to 24 hours.
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
        >
          {verify.isPending ? 'Verifying…' : 'Verify DNS'}
        </Button>
      </div>
    );
  }

  // unconfigured / failed → show the input form.
  return (
    <div className="space-y-3">
      <SenderInput
        domainInput={domainInput}
        setDomainInput={setDomainInput}
        onSave={() => setSender.mutate(domainInput)}
        isPending={setSender.isPending}
      />
      {currentStatus === 'failed' && (
        <p className="text-sm text-red-600">
          <span aria-hidden="true">✗</span> Last verification attempt failed. Re-register your
          sender domain to try again.
        </p>
      )}
      {recentResponse && <DkimInstructions data={recentResponse} />}
    </div>
  );
}

function SenderInput({
  domainInput,
  setDomainInput,
  onSave,
  isPending,
}: {
  domainInput: string;
  setDomainInput: (v: string) => void;
  onSave: () => void;
  isPending: boolean;
}) {
  const inputValid = FQDN_REGEX.test(domainInput);

  return (
    <>
      <Input
        type="text"
        value={domainInput}
        onChange={(e) => setDomainInput(e.target.value.toLowerCase())}
        placeholder="mail.acmeconsulting.com.au"
        className="font-mono max-w-md"
        autoComplete="off"
      />
      {domainInput !== '' && !inputValid && (
        <p className="text-sm text-red-600" aria-live="polite">
          <span aria-hidden="true">✗</span> Must be a lowercase FQDN like mail.acme.com.au
        </p>
      )}
      <Button type="button" onClick={onSave} disabled={!inputValid || isPending}>
        {isPending ? 'Registering…' : 'Register sender domain'}
      </Button>
    </>
  );
}

function DkimInstructions({ data }: { data: SetEmailSenderResponse }) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm space-y-2">
      <p className="font-medium">Publish these 3 TXT records to verify ownership:</p>
      <table className="w-full text-left text-xs font-mono">
        <thead>
          <tr className="border-b border-amber-200">
            <th className="py-1 pr-2 font-medium">Name</th>
            <th className="py-1 pr-2 font-medium">Type</th>
            <th className="py-1 font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.dkim_records.map((r) => (
            <tr key={r.name} className="border-b border-amber-100 last:border-0">
              <td className="py-1 pr-2 break-all">{r.name}</td>
              <td className="py-1 pr-2">{r.type}</td>
              <td className="py-1 break-all">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground whitespace-pre-line">{data.instructions}</p>
    </div>
  );
}
