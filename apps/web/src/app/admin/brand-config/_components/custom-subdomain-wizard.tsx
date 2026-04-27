'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  checkSubdomainAvailability,
  updateBrandConfig,
  type SubdomainAvailabilityReason,
} from '../_lib/api';

/**
 * Custom subdomain wizard (T-C5).
 *
 * Live availability indicator on a 300ms debounce — every keystroke
 * after the debounce window pings POST /custom-subdomain/check-availability
 * and the indicator reflects { available, reason } from the server. The
 * Save button is disabled until the input is format-valid AND available.
 *
 * On save we PATCH /v1/brand-config — the server re-checks uniqueness
 * inline so a TOCTOU race between the availability ping and the PATCH
 * surfaces as a 409 (handled in the mutation's onError).
 *
 * Design Q for later: should we offer a "swap" flow when the firm wants
 * to change their existing slug? Today saving over your own slug is a
 * no-op; saving a *new* slug works but old links break. Out of scope
 * for v1 — the read view shows the current slug so you can copy / paste
 * it manually if needed.
 */

const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const PLATFORM_HOST = 'platform.com.au';

type Status =
  | { kind: 'idle' }
  | { kind: 'invalid' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: SubdomainAvailabilityReason };

export function CustomSubdomainWizard({
  currentSubdomain,
}: {
  currentSubdomain: string | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [value, setValue] = useState(currentSubdomain ?? '');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced availability check. Skip when the input is empty or the
  // value still matches the persisted slug (no point pinging the server
  // for a no-op). The cleanup cancels in-flight timers when `value`
  // changes mid-debounce, so only the final keystroke fires the request.
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (value === '') {
      setStatus({ kind: 'idle' });
      return;
    }
    if (value === currentSubdomain) {
      setStatus({ kind: 'available' });
      return;
    }
    if (!SUBDOMAIN_REGEX.test(value)) {
      setStatus({ kind: 'invalid' });
      return;
    }

    setStatus({ kind: 'checking' });
    debounceRef.current = setTimeout(() => {
      let cancelled = false;
      void checkSubdomainAvailability(value)
        .then((res) => {
          if (cancelled) return;
          if (res.available) {
            setStatus({ kind: 'available' });
          } else {
            setStatus({ kind: 'unavailable', reason: res.reason ?? 'taken' });
          }
        })
        .catch(() => {
          if (!cancelled) setStatus({ kind: 'idle' });
        });
      return () => {
        cancelled = true;
      };
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [value, currentSubdomain]);

  const save = useMutation({
    mutationFn: (subdomain: string) => updateBrandConfig({ custom_subdomain: subdomain }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'White-label URL updated' });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      toast({
        title: 'Save failed',
        description: msg,
        variant: 'destructive',
      });
    },
  });

  const canSave =
    status.kind === 'available' && value !== '' && value !== currentSubdomain;

  return (
    <div className="space-y-3">
      {currentSubdomain && (
        <p className="text-sm text-muted-foreground">
          Your current white-label URL:{' '}
          <code className="text-foreground">https://{currentSubdomain}.{PLATFORM_HOST}</code>
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          placeholder="your-firm"
          className="font-mono max-w-xs"
          autoComplete="off"
        />
        <span className="text-sm text-muted-foreground">.{PLATFORM_HOST}</span>
      </div>
      <StatusIndicator status={status} />
      <Button
        type="button"
        onClick={() => save.mutate(value)}
        disabled={!canSave || save.isPending}
      >
        {save.isPending ? 'Saving…' : 'Save subdomain'}
      </Button>
    </div>
  );
}

/**
 * Inline status next to the input. Plain text + a glyph — no toast
 * spam on every keystroke. `aria-live="polite"` so screen readers
 * announce transitions without interrupting typing.
 */
function StatusIndicator({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;

  let glyph: string;
  let text: string;
  let className: string;

  switch (status.kind) {
    case 'invalid':
      glyph = '✗';
      text = '3-30 chars, lowercase letters/digits/dashes, no leading or trailing dash';
      className = 'text-red-600';
      break;
    case 'checking':
      glyph = '⏳';
      text = 'Checking availability…';
      className = 'text-slate-500';
      break;
    case 'available':
      glyph = '✓';
      text = 'Available';
      className = 'text-emerald-600';
      break;
    case 'unavailable':
      glyph = '✗';
      text =
        status.reason === 'reserved'
          ? 'Reserved for the platform'
          : status.reason === 'invalid_format'
            ? 'Invalid format'
            : 'Already taken';
      className = 'text-red-600';
      break;
  }

  return (
    <p className={`text-sm ${className}`} aria-live="polite">
      <span aria-hidden="true">{glyph}</span> {text}
    </p>
  );
}
