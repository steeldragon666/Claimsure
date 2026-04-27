import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../src/branding/theme-provider.js';
import { runMigrations } from '../src/db/migrations.js';

export default function RootLayout() {
  // One client per app instance. Held in state so the ref is stable
  // across re-renders without re-instantiating the cache. (Default
  // QueryClient options are reasonable for a mobile app — short
  // staleTime + retry-on-network-restore is a Swimlane-B follow-up.)
  const [queryClient] = useState(() => new QueryClient());

  // Run SQLite migrations once on cold start. Errors are surfaced
  // through the standard React error boundary; if the DB is wedged
  // the user sees a crash screen rather than silent corruption.
  useEffect(() => {
    void runMigrations();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(unauthed)" />
          <Stack.Screen name="(authed)" />
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
