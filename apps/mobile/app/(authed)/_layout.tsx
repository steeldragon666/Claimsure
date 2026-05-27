import { View } from 'react-native';
import { Redirect, Stack, usePathname } from 'expo-router';
import { useSessionStore } from '../../src/auth/session-store.js';
import { OnlineIndicator } from '../../src/components/online-indicator.js';
import { usePendingEngagement } from '../../src/hooks/use-pending-engagement.js';

/**
 * Authed layout — every screen renders below the F16 sync banner.
 *
 * The View wrapper exists only so the indicator stacks above the
 * Stack navigator; without it expo-router would complain that the
 * layout returned multiple roots. flex:1 propagates available
 * height to the navigator; the indicator's own height is intrinsic.
 *
 * **First-launch engagement gate (Wizard Step 1, Task 05):**
 * When `usePendingEngagement()` resolves to a non-null engagement
 * letter, every authed route is redirected to `/engagement-sign`
 * EXCEPT the sign screen itself (else we'd ping-pong). The hook
 * stays disabled until the session lands, so the unauthed →
 * `<Redirect href="/(unauthed)/login" />` branch still wins on a
 * cold-start with no session.
 *
 * While the hook is still loading (no cached value, no result yet),
 * we render the Stack normally. The gate is best-effort: a worst-
 * case sub-second window where the user sees the home screen before
 * the redirect kicks in is preferable to a blocking spinner over
 * every cold start. Once the query resolves, the redirect lands.
 */
export default function AuthedLayout() {
  const session = useSessionStore((s) => s.session);
  const pathname = usePathname();
  const pending = usePendingEngagement();
  if (!session) return <Redirect href="/(unauthed)/login" />;
  if (pending.data && pathname !== '/engagement-sign') {
    return <Redirect href="/engagement-sign" />;
  }
  return (
    <View style={{ flex: 1 }}>
      <OnlineIndicator />
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}
