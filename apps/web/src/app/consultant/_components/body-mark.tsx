'use client';

import { useEffect } from 'react';

/**
 * Tags <body data-consultant-workspace="true"> for the duration of this
 * route, so `consultant.css` can scope its html / body / scrollbar
 * overrides without leaking to the rest of the app. Removes the
 * attribute on unmount.
 */
export function ConsultantBodyMark() {
  useEffect(() => {
    document.body.dataset['consultantWorkspace'] = 'true';
    return () => {
      delete document.body.dataset['consultantWorkspace'];
    };
  }, []);
  return null;
}
