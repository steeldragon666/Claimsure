import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../src/auth/session-store.js';
import { OnlineIndicator } from '../../src/components/online-indicator.js';

/**
 * Authed layout — every screen renders below the F16 sync banner.
 *
 * The View wrapper exists only so the indicator stacks above the
 * Stack navigator; without it expo-router would complain that the
 * layout returned multiple roots. flex:1 propagates available
 * height to the navigator; the indicator's own height is intrinsic.
 */
export default function AuthedLayout() {
  const session = useSessionStore((s) => s.session);
  if (!session) return <Redirect href="/(unauthed)/login" />;
  return (
    <View style={{ flex: 1 }}>
      <OnlineIndicator />
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}
