import type { Metadata } from 'next';
import './consultant.css';
import { ConsultantBodyMark } from './_components/body-mark';

export const metadata: Metadata = {
  title: 'Consultant workspace',
};

/**
 * Route-scoped layout for the broadcast consultant workspace.
 *
 * Adds a `data-consultant-workspace` attribute to <body> while this route
 * is mounted — `consultant.css` keys its overrides off that attribute so
 * the rest of the app's globals stay untouched.
 */
export default function ConsultantLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ConsultantBodyMark />
      {children}
    </>
  );
}
