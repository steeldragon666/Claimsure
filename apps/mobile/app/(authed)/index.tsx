import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../src/branding/use-theme.js';
import { useSessionStore } from '../../src/auth/session-store.js';

/**
 * Authed home screen.
 *
 * Renders a per-tenant themed header (T-C14 + T-C15) using the firm
 * brand_config — primary_color background, display_name as the title.
 * The body remains the v1 placeholder until Swimlane B's nav UX lands.
 */
export default function HomeScreen() {
  const theme = useTheme();
  const session = useSessionStore((s) => s.session);
  const displayName = session?.brand_config.display_name ?? 'CPA Scribe';
  return (
    <View style={styles.container}>
      <View style={[styles.header, { backgroundColor: theme.primary_color }]}>
        <Text style={styles.headerLabel}>{displayName}</Text>
      </View>
      <View style={styles.body}>
        <Text>Home</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingVertical: 16, paddingHorizontal: 20 },
  headerLabel: { color: 'white', fontSize: 18, fontWeight: '700' },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
