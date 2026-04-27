import { View, Text } from 'react-native';
import { useIsOnline } from '../sync/network-detector.js';
import { useQueueDepth } from '../sync/queue.js';
import { useTheme } from '../branding/use-theme.js';

/**
 * Network-state banner shown above every authed screen (T-F16).
 *
 * Three visible states (the banner hides itself otherwise):
 *   - Online + queue empty                → null (no banner — the steady state)
 *   - Online + queue non-empty            → primary_color "Syncing N event(s)…"
 *   - Offline (regardless of queue depth) → orange "Offline — N queued"
 *
 * Online colour comes from the active theme's `primary_color` (T-C14
 * + T-C15) so per-firm branding flows through to this banner. The
 * offline amber is hardcoded — "we can't reach the network" is a
 * platform state, not a tenant-customisable look.
 *
 * Inline styles because the mobile app doesn't have a CSS-in-JS layer
 * yet (Swimlane B might add one); keeping the styles local means
 * swapping themes later is a single-file change.
 *
 * Accessibility: the banner is a plain View — VoiceOver / TalkBack
 * read the inner Text label. The colour-on-colour combo here is a
 * known a11y compromise pending the Swimlane-B icon set.
 */
export function OnlineIndicator() {
  const online = useIsOnline();
  const depth = useQueueDepth();
  const theme = useTheme();

  // Steady state — no banner. We deliberately don't render an empty
  // View with zero height because Stack.Screen's measurements get
  // simpler when the indicator is genuinely absent.
  if (online && depth === 0) return null;

  const bg = online ? theme.primary_color : '#f59e0b';
  const label = online
    ? `Syncing ${depth} event${depth !== 1 ? 's' : ''}…`
    : `Offline — ${depth} queued`;

  return (
    <View style={{ backgroundColor: bg, padding: 8 }}>
      <Text style={{ color: 'white', textAlign: 'center', fontSize: 12 }}>{label}</Text>
    </View>
  );
}
