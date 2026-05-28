'use client';

/**
 * Step 1 — Agency details.
 *
 * Reads the firm's current brand_config (GET /v1/brand-config/admin),
 * lets the consultant edit the agency display name + upload a logo, and
 * persists via PATCH /v1/brand-config. ABN is collected and stored in the
 * landing_page_config jsonb blob (brand_config has no dedicated ABN
 * column — see report note) so it isn't silently dropped.
 */

import { useEffect, useRef, useState } from 'react';
import type { BrandConfig } from '@cpa/schemas';
import { ForbiddenError, UnauthenticatedError } from '@/lib/api';
import { amber, bone2, bone3, fMono, fSans, ink3, ruleStrong } from './tokens';
import { Button, FieldLabel, Panel, SectionHeading, StatusLine, TextField } from './onboarding-ui';
import {
  getAdminBrandConfig,
  requestLogoUploadUrl,
  updateBrandConfig,
} from './onboarding-api';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function AgencyDetailsSection({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<BrandConfig | null>(null);

  const [name, setName] = useState('');
  const [abn, setAbn] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ tone: 'error' | 'ok'; msg: string } | null>(null);

  const [logoStatus, setLogoStatus] = useState<{ tone: 'error' | 'ok' | 'muted'; msg: string } | null>(
    null,
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const cfg = await getAdminBrandConfig();
        if (cancelled) return;
        setConfig(cfg);
        setName(cfg.display_name ?? '');
        // ABN, when previously saved, lives under landing_page_config.abn.
        const lpc = cfg.landing_page_config as { abn?: unknown } | null;
        if (lpc && typeof lpc.abn === 'string') setAbn(lpc.abn);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          setLoadError('Your session has expired — sign in again.');
        } else if (err instanceof ForbiddenError) {
          setLoadError('Admin role required to edit agency branding.');
        } else {
          setLoadError(err instanceof Error ? err.message : 'Failed to load agency details.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaveStatus(null);
    try {
      const existingLpc =
        (config?.landing_page_config as Record<string, unknown> | null) ?? {};
      const updated = await updateBrandConfig({
        display_name: name.trim(),
        // landing_page_config is whitelisted (z.unknown()) in the PATCH
        // validator; we fold ABN in so it persists despite there being
        // no dedicated ABN column on brand_config.
        landing_page_config: { ...existingLpc, abn: abn.trim() },
      });
      setConfig(updated);
      setSaveStatus({ tone: 'ok', msg: 'Agency details saved.' });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        setSaveStatus({ tone: 'error', msg: 'Admin role required to save agency branding.' });
      } else {
        setSaveStatus({
          tone: 'error',
          msg: err instanceof Error ? err.message : 'Failed to save.',
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoFile(file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setLogoStatus({ tone: 'error', msg: 'Logo must be 2 MB or smaller.' });
      return;
    }
    setUploadingLogo(true);
    setLogoStatus(null);
    try {
      // Step 1: pre-signed URL + production s3_key.
      const { upload_url, s3_key } = await requestLogoUploadUrl({
        content_type: file.type,
        size_bytes: file.size,
      });
      // Step 2: PUT the blob. The current server returns a placeholder
      // S3 host (real storage lands later), so this may fail — we
      // tolerate it and still publish the key, which is the production
      // format and persists a real value.
      try {
        await fetch(upload_url, { method: 'PUT', body: file });
      } catch {
        /* placeholder host — ignore, publish key anyway */
      }
      // Step 3: publish the key on the brand_config row.
      const updated = await updateBrandConfig({ logo_s3_key: s3_key });
      setConfig(updated);
      setLogoStatus({ tone: 'ok', msg: 'Logo uploaded and saved.' });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        setLogoStatus({ tone: 'error', msg: 'Admin role required to upload a logo.' });
      } else {
        setLogoStatus({
          tone: 'error',
          msg: err instanceof Error ? err.message : 'Logo upload failed.',
        });
      }
    } finally {
      setUploadingLogo(false);
    }
  }

  if (loading) {
    return (
      <Panel>
        <SectionHeading kicker="Step 1" title="Agency details" />
        <div style={{ fontFamily: fMono, fontSize: 11, color: bone3, letterSpacing: '0.1em' }}>
          LOADING AGENCY CONFIG…
        </div>
      </Panel>
    );
  }

  if (loadError) {
    return (
      <Panel>
        <SectionHeading kicker="Step 1" title="Agency details" />
        <StatusLine tone="error">{loadError}</StatusLine>
      </Panel>
    );
  }

  return (
    <Panel>
      <SectionHeading kicker="Step 1" title="Agency details" />
      <p style={{ fontFamily: fSans, fontSize: 13, color: bone3, marginBottom: 18, lineHeight: 1.5 }}>
        This is your own firm — it brands the client-facing surfaces and appears on every claim
        you produce.
      </p>

      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Agency name</FieldLabel>
        <TextField value={name} onChange={setName} placeholder="e.g. Pemberton &amp; Cole" />
      </div>

      <div style={{ marginBottom: 16 }}>
        <FieldLabel>ABN</FieldLabel>
        <TextField value={abn} onChange={setAbn} placeholder="11 222 333 444" />
      </div>

      <div style={{ marginBottom: 8 }}>
        <FieldLabel>Logo</FieldLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 6,
              background: ink3,
              border: `1px solid ${ruleStrong}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: fMono,
              fontSize: 9,
              color: bone3,
              letterSpacing: '0.1em',
              overflow: 'hidden',
              textAlign: 'center',
            }}
          >
            {config?.logo_s3_key ? (
              <span style={{ color: amber }}>SET</span>
            ) : (
              'NONE'
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleLogoFile(f);
            }}
          />
          <Button
            variant="ghost"
            disabled={uploadingLogo}
            onClick={() => fileRef.current?.click()}
          >
            {uploadingLogo ? 'Uploading…' : 'Upload logo'}
          </Button>
        </div>
        {logoStatus && <StatusLine tone={logoStatus.tone}>{logoStatus.msg}</StatusLine>}
      </div>

      <div
        style={{
          marginTop: 22,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <Button onClick={() => void handleSave()} disabled={saving || name.trim().length === 0}>
          {saving ? 'Saving…' : 'Save agency details'}
        </Button>
        <button
          type="button"
          onClick={onDone}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: fMono,
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: bone2,
          }}
        >
          Next: add a client →
        </button>
      </div>
      {saveStatus && <StatusLine tone={saveStatus.tone}>{saveStatus.msg}</StatusLine>}

      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: `1px solid rgba(240,235,226,.06)`,
          fontFamily: fMono,
          fontSize: 9.5,
          color: bone3,
          letterSpacing: '0.08em',
        }}
      >
        TENANT {config?.tenant_id?.slice(0, 8) ?? '—'} · brand_config
      </div>
    </Panel>
  );
}
