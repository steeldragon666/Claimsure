'use client';

import { amber, fMono, ink } from './tokens';

/**
 * Top-of-page banner indicating /consultant is a design preview, not a wired
 * workspace. Every panel in this surface reads from hardcoded fixture arrays
 * (CLAIMS[], SIGNALS[], BLOCKS[], LEDGER[], EVIDENCE[], etc.) — no API calls.
 *
 * Delete this component and its import from page.tsx the moment the views
 * become data-backed. There's no dismissed state by design: a real preview
 * shouldn't be hideable.
 *
 * Uses the existing amber palette token so it sits inside the consultant
 * design system rather than imposing a foreign color. fMono + 0.22em
 * tracking matches the MonoLabel treatment used elsewhere on the page.
 */
export function PreviewBanner(): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        background: amber,
        color: ink,
        fontFamily: fMono,
        fontSize: 11,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        padding: '8px 16px',
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      Preview · Design surface only · Every value on this page is fictional
    </div>
  );
}
