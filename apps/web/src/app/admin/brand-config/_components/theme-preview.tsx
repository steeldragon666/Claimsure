'use client';

/**
 * Live preview for the theme picker (T-C3).
 *
 * Renders a small mock — header bar in the primary color, accent text,
 * and a primary-coloured button — using inline styles so the preview
 * tracks the picker's `value` props before any save happens. Both
 * colors are 6-digit hex strings already validated by the parent's
 * react-hook-form resolver; we don't re-validate here.
 */
export function ThemePreview({ primary, accent }: { primary: string; accent: string }) {
  return (
    <div className="rounded-md border overflow-hidden">
      <div
        className="px-4 py-3 text-white text-sm font-medium"
        style={{ backgroundColor: primary }}
      >
        Your firm header
      </div>
      <div className="bg-white px-4 py-4 space-y-2">
        <p className="text-sm">
          Read more about our <span style={{ color: accent }}>R&amp;D Tax Incentive</span> process.
        </p>
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
          style={{ backgroundColor: primary }}
        >
          Get started
        </button>
      </div>
    </div>
  );
}
