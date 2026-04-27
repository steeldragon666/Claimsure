import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createManualTimeEntry,
  listTimeEntries,
  type TimeEntry,
  type TimeEntrySource,
} from '../../src/api-client/time-entries.js';
import { useTheme } from '../../src/branding/use-theme.js';

/**
 * Time-tracking screen (T-B22).
 *
 * Reads the recent time entries from /v1/time-entries (manual +
 * payroll-synced) and surfaces a "+ Add" affordance to log a manual
 * entry. Payroll-synced rows are read-only with a source badge; only
 * manual rows are editable. (Edit / delete UX lands in a follow-up;
 * v1 is list + create.)
 *
 * Pre-merge with the Swimlane-B time-entry API the list returns []
 * gracefully — the API client soft-fails 404s so the user sees "No
 * entries yet" rather than an error toast.
 */
export default function TimeScreen() {
  const theme = useTheme();
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['time-entries'],
    queryFn: listTimeEntries,
  });

  const entries = data ?? [];

  return (
    <View style={styles.container}>
      <View style={[styles.header, { backgroundColor: theme.primary_color }]}>
        <Text style={styles.headerLabel}>Time entries</Text>
        <Pressable
          onPress={() => setModalOpen(true)}
          style={styles.addButton}
          accessibilityLabel="Add manual time entry"
        >
          <Text style={styles.addButtonLabel}>+ Add</Text>
        </Pressable>
      </View>
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {error instanceof Error ? error.message : 'Failed to load time entries'}
          </Text>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No entries yet — tap + Add to log one.</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TimeEntryRow entry={item} />}
          contentContainerStyle={styles.list}
        />
      )}
      <AddManualEntryModal
        visible={modalOpen}
        onDismiss={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['time-entries'] });
        }}
      />
    </View>
  );
}

/**
 * Single row in the time-entries list.
 *
 * Renders date + duration + source badge + R&D pill. Source label
 * acts as a "where did this come from" hint — payroll-synced rows
 * are read-only so the badge doubles as a "you can't edit this here"
 * affordance.
 */
function TimeEntryRow({ entry }: { entry: TimeEntry }) {
  const start = new Date(entry.started_at);
  const end = entry.ended_at ? new Date(entry.ended_at) : null;
  const durationMs = end ? end.getTime() - start.getTime() : 0;
  const durationLabel = formatDuration(durationMs);
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowDate}>{formatDate(start)}</Text>
        <Text style={styles.rowDuration}>{durationLabel}</Text>
        {entry.notes ? (
          <Text style={styles.rowNotes} numberOfLines={2}>
            {entry.notes}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.sourceBadge}>{labelForSource(entry.source)}</Text>
        {entry.is_rd ? <Text style={styles.rdBadge}>R&D</Text> : null}
      </View>
    </View>
  );
}

/**
 * Modal sheet for logging a manual entry.
 *
 * v1 inputs: ISO8601 started_at + ended_at, is_rd toggle, notes
 * textbox. Date / time pickers land alongside the rest of B's UX
 * polish — keeping it as plain text keeps the dep surface small for
 * now and leaves an obvious upgrade hook.
 */
function AddManualEntryModal(props: {
  visible: boolean;
  onDismiss: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');
  const [isRd, setIsRd] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: createManualTimeEntry,
    onSuccess: () => {
      setStartedAt('');
      setEndedAt('');
      setIsRd(false);
      setNotes('');
      setError(null);
      props.onSaved();
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to save entry');
    },
  });

  const canSubmit = startedAt.trim().length > 0 && endedAt.trim().length > 0 && !mutation.isPending;

  function handleSubmit(): void {
    if (!canSubmit) return;
    mutation.mutate({
      started_at: startedAt.trim(),
      ended_at: endedAt.trim(),
      is_rd: isRd,
      ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
    });
  }

  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onDismiss}>
      <View style={styles.modalContainer}>
        <Text style={styles.modalTitle}>Add manual entry</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.field}>
          <Text style={styles.label}>Started at (ISO8601)</Text>
          <TextInput
            style={styles.input}
            value={startedAt}
            onChangeText={setStartedAt}
            editable={!mutation.isPending}
            placeholder="2026-04-27T09:00:00Z"
            placeholderTextColor="#999"
            autoCapitalize="none"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Ended at (ISO8601)</Text>
          <TextInput
            style={styles.input}
            value={endedAt}
            onChangeText={setEndedAt}
            editable={!mutation.isPending}
            placeholder="2026-04-27T11:30:00Z"
            placeholderTextColor="#999"
            autoCapitalize="none"
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.label}>R&amp;D-eligible</Text>
          <Switch value={isRd} onValueChange={setIsRd} disabled={mutation.isPending} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={[styles.input, styles.notes]}
            value={notes}
            onChangeText={setNotes}
            editable={!mutation.isPending}
            multiline
            placeholder="What were you working on?"
            placeholderTextColor="#999"
          />
        </View>

        <View style={styles.modalActions}>
          <Pressable onPress={props.onDismiss} style={[styles.modalButton, styles.cancelButton]}>
            <Text style={styles.modalButtonLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={[
              styles.modalButton,
              { backgroundColor: canSubmit ? theme.primary_color : '#cbd5e1' },
            ]}
          >
            <Text style={styles.modalButtonLabel}>{mutation.isPending ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/* ------- helpers ------- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function labelForSource(s: TimeEntrySource): string {
  switch (s) {
    case 'manual':
      return 'Manual';
    case 'employment_hero':
      return 'Employment Hero';
    case 'keypay':
      return 'KeyPay';
    case 'deputy':
      return 'Deputy';
    case 'xero_payroll':
      return 'Xero Payroll';
    default:
      return s;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLabel: { color: 'white', fontSize: 18, fontWeight: '700' },
  addButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 6,
  },
  addButtonLabel: { color: 'white', fontWeight: '600', fontSize: 14 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#666', fontSize: 14, textAlign: 'center' },
  error: { color: '#dc2626', fontSize: 13, marginBottom: 8, textAlign: 'center' },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    gap: 12,
    alignItems: 'flex-start',
  },
  rowMain: { flex: 1, gap: 4 },
  rowDate: { fontSize: 14, fontWeight: '600' },
  rowDuration: { fontSize: 13, color: '#374151' },
  rowNotes: { fontSize: 12, color: '#6b7280' },
  rowMeta: { alignItems: 'flex-end', gap: 4 },
  sourceBadge: {
    fontSize: 10,
    color: '#6b7280',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  rdBadge: {
    fontSize: 10,
    color: 'white',
    backgroundColor: '#10b981',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    fontWeight: '700',
  },
  modalContainer: { flex: 1, padding: 20, gap: 12, paddingTop: 60 },
  modalTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  field: { gap: 4 },
  label: { fontSize: 13, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
  },
  notes: { minHeight: 80, textAlignVertical: 'top' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  modalButton: { flex: 1, padding: 14, borderRadius: 6, alignItems: 'center' },
  cancelButton: { backgroundColor: '#9ca3af' },
  modalButtonLabel: { color: 'white', fontWeight: '600' },
});
