import { Link } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSessionStore } from '../../src/auth/session-store.js';

const ink = '#0b0b0d';
const ink2 = '#131316';
const ink3 = '#1c1c20';
const bone = '#f0ebe2';
const bone2 = '#cdc7bd';
const bone3 = '#8a857c';
const bone4 = '#5d594f';
const amber = '#e1a23a';
const rule = 'rgba(240,235,226,0.10)';
const ruleStrong = 'rgba(240,235,226,0.22)';

const recentCaptures = [
  { kind: 'PHOTO', title: 'Furnace setup N12', time: '09:14', block: '#3F' },
  { kind: 'VOICE', title: 'Pre-run hypothesis', time: '09:18', block: '#3E' },
  { kind: 'TIME', title: 'Quench rate target', time: '09:42', block: '#3D' },
  { kind: 'DOC', title: 'Specimen pre-cycle', time: '09:51', block: '#3C' },
];

const captureActions = [
  { label: 'Voice', href: '/(authed)/capture/voice', sub: 'Transcript + timestamp' },
  { label: 'Photo', href: '/(authed)/capture/photo', sub: 'Image evidence' },
  { label: 'Document', href: '/(authed)/capture/document', sub: 'File artefact' },
  { label: 'Hypothesis', href: '/(authed)/hypothesis', sub: 'Plan before experiment' },
  { label: 'Time', href: '/(authed)/time', sub: 'Labour record' },
] as const;

function Diamond({ size = 7 }: { size?: number }) {
  return <View style={[styles.diamond, { height: size, width: size }]} />;
}

function MonoLabel({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={[styles.monoLabel, muted && styles.monoMuted]}>{children}</Text>;
}

/**
 * Claimant Today screen.
 *
 * This implements the first screen from the ArchiveOne claimant-mobile UI kit:
 * active project, advisor nudge, today's sealed captures, and quick capture
 * actions. The links route into the existing capture primitives so the screen
 * upgrades the product surface without bypassing the working queue/sync paths.
 */
export default function HomeScreen() {
  const session = useSessionStore((s) => s.session);
  const displayName = session?.employee.name?.split(' ')[0] ?? 'Priya';
  const firmName = session?.brand_config.display_name ?? 'ArchiveOne';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <View style={styles.brandRow}>
              <Diamond />
              <MonoLabel muted>{firmName}</MonoLabel>
            </View>
            <Text style={styles.title}>Good morning, {displayName}.</Text>
            <Text style={styles.subtitle}>Vantage Industries - 12 captures today</Text>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(displayName)}</Text>
          </View>
        </View>

        <View style={styles.activeCard}>
          <View style={styles.rowBetween}>
            <MonoLabel>ACTIVE - CORE</MonoLabel>
            <MonoLabel muted>FY26/27</MonoLabel>
          </View>
          <Text style={styles.projectTitle}>Vantage-7 alloy</Text>
          <Text style={styles.projectBody}>Phase-stability program - furnace run N12 in progress</Text>
          <View style={styles.projectStats}>
            <Text style={styles.statText}>
              <Text style={styles.statValue}>12</Text> ARTIFACTS TODAY
            </Text>
            <Text style={styles.statText}>
              <Text style={styles.statValue}>47</Text> TOTAL
            </Text>
            <Text style={styles.statText}>
              <Text style={styles.statValue}>3</Text> GAPS
            </Text>
          </View>
        </View>

        <View style={styles.advisorCard}>
          <View style={styles.advisorTop}>
            <Diamond size={6} />
            <MonoLabel>ADVISOR</MonoLabel>
            <Text style={styles.timestamp}>2 mins ago</Text>
          </View>
          <Text style={styles.advisorText}>
            Morning {displayName}. Vantage-7 furnace run N12 - same protocol as N7?
          </Text>
        </View>

        <View style={styles.sectionHeader}>
          <MonoLabel muted>TODAY - 22 MAY</MonoLabel>
        </View>

        {recentCaptures.map((item) => (
          <View key={`${item.kind}-${item.block}`} style={styles.captureRow}>
            <View style={styles.captureIcon}>
              <Text style={styles.captureIconText}>{item.kind.slice(0, 1)}</Text>
            </View>
            <View style={styles.captureCopy}>
              <Text style={styles.captureTitle}>{item.title}</Text>
              <Text style={styles.captureMeta}>
                {item.kind} - {item.time} - SEALED
              </Text>
            </View>
            <Text style={styles.blockText}>{item.block}</Text>
          </View>
        ))}

        <View style={styles.actionsGrid}>
          {captureActions.map((action) => (
            <Link key={action.label} href={action.href} asChild>
              <Text style={styles.actionCard}>
                <Text style={styles.actionLabel}>{action.label}</Text>
                {'\n'}
                <Text style={styles.actionSub}>{action.sub}</Text>
              </Text>
            </Link>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return letters || 'PR';
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: ink,
    flex: 1,
  },
  scroll: {
    paddingBottom: 36,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  header: {
    alignItems: 'flex-start',
    borderBottomColor: rule,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 16,
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  diamond: {
    backgroundColor: amber,
    transform: [{ rotate: '45deg' }],
  },
  monoLabel: {
    color: amber,
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.8,
  },
  monoMuted: {
    color: bone3,
  },
  title: {
    color: bone,
    fontFamily: 'serif',
    fontSize: 28,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  subtitle: {
    color: bone3,
    fontSize: 12,
    marginTop: 4,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: amber,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  avatarText: {
    color: ink,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
  },
  activeCard: {
    backgroundColor: 'rgba(225,162,58,0.06)',
    borderColor: amber,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
    padding: 18,
  },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  projectTitle: {
    color: bone,
    fontFamily: 'serif',
    fontSize: 24,
    fontWeight: '500',
    marginTop: 12,
  },
  projectBody: {
    color: bone2,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 7,
  },
  projectStats: {
    borderTopColor: rule,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 15,
    paddingTop: 11,
  },
  statText: {
    color: bone3,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 0.8,
  },
  statValue: {
    color: amber,
  },
  advisorCard: {
    backgroundColor: ink2,
    borderColor: ruleStrong,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  advisorTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 9,
  },
  timestamp: {
    color: bone4,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 9,
    textAlign: 'right',
  },
  advisorText: {
    color: bone,
    fontFamily: 'serif',
    fontSize: 17,
    lineHeight: 23,
  },
  sectionHeader: {
    marginBottom: 10,
    marginTop: 18,
  },
  captureRow: {
    alignItems: 'center',
    backgroundColor: ink2,
    borderColor: rule,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 7,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  captureIcon: {
    alignItems: 'center',
    backgroundColor: ink3,
    borderColor: ruleStrong,
    borderRadius: 6,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  captureIconText: {
    color: amber,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
  },
  captureCopy: {
    flex: 1,
  },
  captureTitle: {
    color: bone,
    fontSize: 14,
    fontWeight: '600',
  },
  captureMeta: {
    color: bone3,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1,
    marginTop: 3,
  },
  blockText: {
    color: amber,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  actionCard: {
    backgroundColor: ink2,
    borderColor: ruleStrong,
    borderRadius: 8,
    borderWidth: 1,
    color: bone,
    flexGrow: 1,
    flexBasis: '47%',
    fontSize: 14,
    lineHeight: 21,
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  actionLabel: {
    color: bone,
    fontWeight: '700',
  },
  actionSub: {
    color: bone3,
    fontSize: 11,
  },
});
