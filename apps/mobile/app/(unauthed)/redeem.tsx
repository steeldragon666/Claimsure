import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { redeemMagicLink } from '../../src/auth/redeem.js';
import { useSessionStore } from '../../src/auth/session-store.js';

/**
 * Magic-link redemption screen.
 *
 * Hit when the user taps a magic-link in email — the URL scheme
 * `cpa-scribe://auth/redeem?t=<token>` opens the app at this route.
 * We decode the token, POST it to /v1/auth/magic-link/redeem, persist
 * the resulting session, and redirect to the authed home.
 *
 * The 1h access-token expiry is captured at redemption time so the
 * F8 refresh hook (Swimlane A) knows when to swap it. We add the 1h
 * window client-side instead of trusting a server-provided expires_at
 * so clock skew between device and server doesn't strand the token —
 * worst case we refresh a few minutes early.
 */
export default function RedeemScreen() {
  const params = useLocalSearchParams<{ t?: string }>();
  const setSession = useSessionStore((s) => s.setSession);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      const token = typeof params.t === 'string' ? params.t : null;
      if (!token) {
        if (!cancelled) setError('Missing magic-link token.');
        return;
      }
      try {
        const res = await redeemMagicLink({ token });
        if (cancelled) return;
        // brand_config from the redeem response is the trimmed
        // MagicLinkRedeemBrand shape; we lift it into the wider
        // BrandConfig the rest of the app speaks. Missing fields are
        // filled with nulls — F15 fetches the full brand_config on
        // next launch and replaces this placeholder.
        const fullBrand = {
          tenant_id: res.employee.tenant_id,
          display_name: res.brand_config.display_name,
          primary_color: res.brand_config.primary_color,
          accent_color: res.brand_config.accent_color,
          logo_s3_key: res.brand_config.logo_s3_key,
          support_email: null,
          terms_of_service_url: null,
          custom_subdomain: null,
          custom_domain: null,
          landing_page_config: null,
        };
        setSession({
          access_token: res.access_token,
          refresh_token: res.refresh_token,
          access_token_expires_at: Date.now() + 60 * 60 * 1000,
          employee: res.employee,
          brand_config: fullBrand,
        });
        setDone(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Sign-in failed.');
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [params.t, setSession]);

  if (done) return <Redirect href="/(authed)" />;

  return (
    <View style={styles.container}>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <>
          <ActivityIndicator size="large" />
          <Text style={styles.body}>Signing you in…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  body: { fontSize: 16, marginTop: 16 },
  error: { fontSize: 16, color: '#c0392b', textAlign: 'center' },
});
