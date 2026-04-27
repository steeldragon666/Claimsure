import { Stack } from 'expo-router';

export default function UnauthedLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
