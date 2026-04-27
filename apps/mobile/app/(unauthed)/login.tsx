import { View, Text, StyleSheet } from 'react-native';

/**
 * Login landing page.
 *
 * Mobile auth is magic-link only — there's no password field. The
 * consultant invites the employee from the web app, the employee
 * receives an email, taps the link, and lands on /(unauthed)/redeem
 * where the token is exchanged for a session. This screen is what
 * shows when the app is opened cold without a stored refresh token.
 *
 * The visible copy here is intentionally bare-bones; the proper
 * branded sign-in screen lands in Swimlane B (UI) once the brand
 * theme provider (F15) is in place.
 */
export default function LoginScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>CPA Scribe</Text>
      <Text style={styles.body}>Check your email for a sign-in link from your firm.</Text>
      <Text style={styles.help}>Tap the link on this device to continue.</Text>
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
  title: { fontSize: 28, fontWeight: '700', marginBottom: 16 },
  body: { fontSize: 16, textAlign: 'center', marginBottom: 8 },
  help: { fontSize: 14, color: '#666', textAlign: 'center' },
});
