import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  usePendingEngagement,
  useInvalidatePendingEngagement,
} from '../../src/hooks/use-pending-engagement.js';
import { signEngagement, declineEngagement } from '../../src/api-client/engagement.js';
import { useTheme } from '../../src/branding/use-theme.js';

/**
 * Engagement-letter first-launch sign screen
 * (Wizard Step 1, Task 05 — docs/plans/wizard-step-1/05-mobile-sign-screen.md).
 *
 * The authed `_layout.tsx` redirects here when `usePendingEngagement`
 * resolves to a non-null row; this screen owns the sign / decline /
 * refresh actions and pops back to home when the gate is cleared.
 *
 * UX:
 *   - The letter body renders as monospace pre-formatted markdown
 *     (the spec calls for monospace for the legal text). We do NOT
 *     pull in `react-native-markdown-display` — the existing app
 *     ships with no markdown deps, and the legal text in the
 *     engagement template is short + monospace-friendly without
 *     rendering. If/when richer formatting is required (lists,
 *     bold, etc.), swap the <Text> for a markdown renderer here.
 *   - Sign is disabled until BOTH the typed-name field is non-empty
 *     AND the agreement checkbox is ticked. Both gates are explicit
 *     per the spec.
 *   - Decline opens a reason text-area inline (no modal — modals on
 *     RN-iOS dismiss the active keyboard, which fights the input).
 *     Reason is optional; an empty submit is still a decline.
 *   - Pull-to-refresh re-fetches the pending engagement. If the
 *     consultant rescinds the letter (or it expires) while the
 *     screen is open, the pull-to-refresh resolves the gate.
 *
 * Theme: matches the mobile app's existing token system via
 * `useTheme()`. No Tailwind, no shared web tokens — see the
 * top-level CLAUDE.md design-language guardrail.
 */
export default function EngagementSignScreen() {
  const router = useRouter();
  const theme = useTheme();
  const query = usePendingEngagement();
  const invalidate = useInvalidatePendingEngagement();

  const [typedName, setTypedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [declineMode, setDeclineMode] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const onRefresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const onSign = useCallback(async () => {
    if (!query.data) return;
    if (typedName.trim().length === 0 || !agreed) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await signEngagement(query.data.sendToken, typedName.trim());
      // Server has flipped the claim to 'signed'; invalidate the gate so
      // the authed layout re-evaluates and routes home.
      await invalidate();
      router.replace('/');
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Could not submit signature');
    } finally {
      setSubmitting(false);
    }
  }, [agreed, invalidate, query.data, router, typedName]);

  const onDecline = useCallback(async () => {
    if (!query.data) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const reason = declineReason.trim();
      await declineEngagement(query.data.sendToken, reason.length > 0 ? reason : undefined);
      await invalidate();
      // On decline we DON'T push to home — the claim's engagement_status
      // flips to 'declined' and the home screen would still be gated.
      // Instead surface a terminal "Cannot proceed" message in this
      // screen by leaving query state to refetch + show a declined banner.
      // Implementation: refetching here is a no-op (the server filter on
      // `engagement_status='sent'` makes the row invisible), so the
      // pendingEngagement query goes to null and the authed layout
      // unmounts this screen — which lands the user back at the home
      // screen. For the explicit "cannot proceed" copy the home screen
      // is responsible for reading `claim.engagement_status='declined'`
      // and rendering accordingly. That UI tweak is a follow-up scoped
      // to the home screen, not this task — leaving the home-route
      // re-render to do the right thing.
      router.replace('/');
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Could not submit decline');
    } finally {
      setSubmitting(false);
    }
  }, [declineReason, invalidate, query.data, router]);

  if (query.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (query.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>
          {query.error instanceof Error
            ? query.error.message
            : 'Could not load the engagement letter'}
        </Text>
        <Pressable
          onPress={() => void query.refetch()}
          style={[styles.primary, { backgroundColor: theme.primary_color }]}
        >
          <Text style={styles.primaryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!query.data) {
    // The authed layout shouldn't have routed us here — but the gate
    // can race with a server-side state flip. Bounce to home.
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No engagement letter is pending.</Text>
        <Pressable
          onPress={() => router.replace('/')}
          style={[styles.primary, { backgroundColor: theme.primary_color }]}
        >
          <Text style={styles.primaryLabel}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  const canSign = typedName.trim().length > 0 && agreed && !submitting;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl
          refreshing={query.isFetching && !query.isLoading}
          onRefresh={() => void onRefresh()}
        />
      }
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Engagement letter</Text>
      <Text style={styles.subheading}>
        {query.data.firmName}
        {query.data.consultantName ? ` — ${query.data.consultantName}` : ''}
      </Text>

      <View style={styles.letterCard}>
        <Text style={styles.letterBody}>{query.data.renderedMarkdown}</Text>
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: agreed }}
        onPress={() => setAgreed((v) => !v)}
        style={styles.checkboxRow}
      >
        <View
          style={[
            styles.checkbox,
            agreed && { backgroundColor: theme.primary_color, borderColor: theme.primary_color },
          ]}
        >
          {agreed ? <Text style={styles.checkboxTick}>{'✓'}</Text> : null}
        </View>
        <Text style={styles.checkboxLabel}>I have read and agree to this engagement letter.</Text>
      </Pressable>

      <Text style={styles.fieldLabel}>Type your full name</Text>
      <TextInput
        value={typedName}
        onChangeText={setTypedName}
        editable={!submitting}
        autoCapitalize="words"
        autoCorrect={false}
        placeholder="Full legal name"
        style={styles.input}
      />

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <Pressable
        onPress={() => void onSign()}
        disabled={!canSign}
        style={[
          styles.primary,
          { backgroundColor: theme.primary_color },
          !canSign && styles.primaryDisabled,
        ]}
      >
        <Text style={styles.primaryLabel}>{submitting ? 'Signing…' : 'Sign'}</Text>
      </Pressable>

      {declineMode ? (
        <View style={styles.declineBlock}>
          <Text style={styles.fieldLabel}>Reason for declining (optional)</Text>
          <TextInput
            value={declineReason}
            onChangeText={setDeclineReason}
            editable={!submitting}
            multiline
            numberOfLines={4}
            placeholder="Optional — tell your consultant why"
            style={[styles.input, styles.inputMultiline]}
          />
          <View style={styles.declineActions}>
            <Pressable
              onPress={() => setDeclineMode(false)}
              disabled={submitting}
              style={[styles.secondary, submitting && styles.secondaryDisabled]}
            >
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void onDecline()}
              disabled={submitting}
              style={[styles.dangerous, submitting && styles.dangerousDisabled]}
            >
              <Text style={styles.dangerousLabel}>{submitting ? 'Declining…' : 'Decline'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setDeclineMode(true)}
          disabled={submitting}
          style={[styles.tertiary, submitting && styles.tertiaryDisabled]}
        >
          <Text style={styles.tertiaryLabel}>Decline</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#ffffff' },
  scrollContent: { padding: 24, paddingBottom: 48 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  heading: { fontSize: 22, fontWeight: '700', marginBottom: 4, color: '#0b0b0d' },
  subheading: { fontSize: 14, color: '#5d594f', marginBottom: 16 },
  letterCard: {
    backgroundColor: '#f6f5f1',
    borderRadius: 8,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#e2dfd6',
  },
  letterBody: {
    fontFamily: 'Courier',
    fontSize: 13,
    lineHeight: 20,
    color: '#1c1c20',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 8,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#8a857c',
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  checkboxTick: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  checkboxLabel: { flex: 1, fontSize: 15, color: '#0b0b0d' },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#5d594f', marginBottom: 8, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#cdc7bd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0b0b0d',
    backgroundColor: '#ffffff',
    marginBottom: 16,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  primary: { paddingVertical: 16, paddingHorizontal: 16, borderRadius: 8, marginTop: 8 },
  primaryDisabled: { opacity: 0.5 },
  primaryLabel: { color: '#ffffff', textAlign: 'center', fontWeight: '700', fontSize: 16 },
  tertiary: { paddingVertical: 14, paddingHorizontal: 16, marginTop: 16, alignItems: 'center' },
  tertiaryDisabled: { opacity: 0.5 },
  tertiaryLabel: { color: '#5d594f', fontSize: 15, fontWeight: '600' },
  declineBlock: { marginTop: 24 },
  declineActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  secondary: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cdc7bd',
    backgroundColor: '#ffffff',
  },
  secondaryDisabled: { opacity: 0.5 },
  secondaryLabel: { textAlign: 'center', color: '#0b0b0d', fontWeight: '600', fontSize: 15 },
  dangerous: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#b91c1c',
  },
  dangerousDisabled: { opacity: 0.5 },
  dangerousLabel: { textAlign: 'center', color: '#ffffff', fontWeight: '700', fontSize: 15 },
  error: { color: '#b91c1c', fontSize: 14, marginVertical: 8 },
  empty: { fontSize: 16, color: '#5d594f', marginBottom: 16 },
});
