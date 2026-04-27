import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider } from '../src/branding/theme-provider.js';
import { runMigrations } from '../src/db/migrations.js';

export default function RootLayout() {
  // Run SQLite migrations once on cold start. Errors are surfaced
  // through the standard React error boundary; if the DB is wedged
  // the user sees a crash screen rather than silent corruption.
  useEffect(() => {
    void runMigrations();
  }, []);

  return (
    <ThemeProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(unauthed)" />
        <Stack.Screen name="(authed)" />
      </Stack>
    </ThemeProvider>
  );
}
