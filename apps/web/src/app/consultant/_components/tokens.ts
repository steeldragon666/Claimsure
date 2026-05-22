// Tokens for the ClaimSure broadcast consultant workspace.
// Mirror of ui_kits/consultant-app/consultant-shared.jsx (the v6 design export).
// Inline style values rather than CSS custom properties so the workspace is
// self-contained — the rest of the web app uses the cream/patina + dark-glass
// systems via globals.css. This route is the only consumer of these tokens.

export const ink = '#0b0b0d';
export const ink2 = '#131316';
export const ink3 = '#1c1c20';
export const ink4 = '#252529';

export const bone = '#f0ebe2';
export const bone2 = '#cdc7bd';
export const bone3 = '#8a857c';
export const bone4 = '#5d594f';

export const amber = '#e1a23a';
export const amberSoft = '#b88a3d';
export const sage = '#7a9685';
export const rust = '#c46a48';

export const rule = 'rgba(240,235,226,.10)';
export const ruleStrong = 'rgba(240,235,226,.22)';

// next/font/google CSS variables — wired up in apps/web/src/app/layout.tsx.
// Quoted family names + the platform fallbacks keep behaviour identical to the
// design-export HTML, which used hard-coded Google Fonts strings.
export const fSerif = 'var(--font-display), "Fraunces", "Times New Roman", serif';
export const fSans = 'var(--font-geist), "Geist", ui-sans-serif, system-ui, sans-serif';
export const fMono = 'var(--font-mono), "JetBrains Mono", ui-monospace, monospace';
