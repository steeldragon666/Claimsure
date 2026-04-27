interface Props {
  totalPts: number;
  maxPts: number;
  /**
   * Brand primary color — the gauge stroke uses this so the score viz
   * inherits the firm's white-label palette without a CSS-variable
   * round-trip. Hex like "#0066cc"; falls back to a neutral blue.
   */
  primaryColor?: string;
}

/**
 * Audit-readiness gauge (T-C13).
 *
 * SVG-based circular gauge:
 *   - Background ring (full 360°, light slate)
 *   - Foreground ring (stroke-dasharray showing the percentage)
 *   - Centered text: large "78" + small "/ 100" + "Audit ready" label
 *
 * No client-side JS — pure presentation, server-component compatible.
 *
 * The ring uses stroke-dasharray rather than an arc-path because the
 * dasharray approach lets us animate the fill on hydration (CSS
 * transition on the dasharray) without needing a path-d recalc on every
 * render. We don't actually wire the animation in v1 (the value is
 * static placeholder data) but the structure is animation-ready for
 * D1-D4.
 */
export function AuditScoreGauge({ totalPts, maxPts, primaryColor }: Props) {
  // Clamp 0..1 to avoid a stray 110% from server-side data drift.
  const pct = maxPts > 0 ? Math.max(0, Math.min(1, totalPts / maxPts)) : 0;

  const RADIUS = 80;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const dash = pct * CIRCUMFERENCE;
  const gap = CIRCUMFERENCE - dash;

  // Color the gauge stroke. We accept an inline color rather than a
  // tailwind class because Tailwind can't generate arbitrary stroke
  // colors at build time (the JIT only sees literal class names).
  const stroke = primaryColor ?? '#2563eb';

  return (
    <div className="flex items-center justify-center">
      <svg
        viewBox="0 0 200 200"
        className="h-48 w-48"
        role="img"
        aria-label={`Audit-readiness score ${totalPts} out of ${maxPts}`}
      >
        {/* Background ring */}
        <circle cx="100" cy="100" r={RADIUS} fill="none" stroke="#e2e8f0" strokeWidth="14" />
        {/* Foreground arc — rotated -90° so 0% sits at the top.
            stroke-linecap=round gives the cap a friendly finish at
            partial fills. */}
        <circle
          cx="100"
          cy="100"
          r={RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform="rotate(-90 100 100)"
        />
        {/* Centered text. tspan stacking lets us mix font sizes inside
            one <text> element — semantically still one label. */}
        <text
          x="100"
          y="100"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-slate-900"
          style={{ fontSize: '40px', fontWeight: 700 }}
        >
          {totalPts}
        </text>
        <text
          x="100"
          y="135"
          textAnchor="middle"
          className="fill-slate-500"
          style={{ fontSize: '14px' }}
        >
          / {maxPts} audit ready
        </text>
      </svg>
    </div>
  );
}
