import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { enqueueHypothesisEvent } from '../../src/api-client/hypothesis.js';

/**
 * Hypothesis prompt screen (T-A10).
 *
 * Three-field form for pre-experiment hypothesis capture:
 *   - predicted_outcome  ("what do you predict will happen?")
 *   - success_criteria   ("what does success look like?")
 *   - uncertainty        ("what are you uncertain about?")
 *
 * The framing matters: capturing the hypothesis BEFORE starting work
 * is what makes the activity systematic-experimental under
 * §355-25(1)(a). The header copy makes that explicit so consultants
 * coaching their employees on the platform can reinforce the rule
 * without out-of-band training. (Body by Michael — the audit-finding
 * fix that motivated this screen.)
 *
 * Submit → enqueue a `hypothesis_prompt` event in the local SQLite
 * queue, then route home. The sync worker drains it on the next pass
 * once A11's discriminated-union body schema lands. No network call
 * from this screen — keeps the path offline-clean.
 */
export default function HypothesisScreen() {
  const router = useRouter();
  const [predicted, setPredicted] = useState('');
  const [success, setSuccess] = useState('');
  const [uncertainty, setUncertainty] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enable the submit button only when all three fields have non-
  // whitespace content. The classifier upstream treats empty strings
  // as missing, so client-side gating saves the round-trip.
  const canSubmit =
    predicted.trim().length > 0 &&
    success.trim().length > 0 &&
    uncertainty.trim().length > 0 &&
    !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await enqueueHypothesisEvent({
        predicted_outcome: predicted.trim(),
        success_criteria: success.trim(),
        uncertainty: uncertainty.trim(),
        captured_at_local: Date.now(),
      });
      router.replace('/(authed)');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'enqueue failed');
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Pre-experiment hypothesis</Text>
      <Text style={styles.helpHeader}>
        Capture this BEFORE starting work — pre-dating the hypothesis is what makes the activity
        systematic-experimental under §355-25(1)(a).
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.field}>
        <Text style={styles.label}>What outcome do you predict?</Text>
        <TextInput
          style={styles.input}
          multiline
          value={predicted}
          onChangeText={setPredicted}
          editable={!submitting}
          placeholder="e.g. We expect the catalyst to lift conversion by 5%."
          placeholderTextColor="#999"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>What does success look like?</Text>
        <TextInput
          style={styles.input}
          multiline
          value={success}
          onChangeText={setSuccess}
          editable={!submitting}
          placeholder="e.g. Conversion ≥ 90% with no impurity above 0.5%."
          placeholderTextColor="#999"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>What are you uncertain about?</Text>
        <TextInput
          style={styles.input}
          multiline
          value={uncertainty}
          onChangeText={setUncertainty}
          editable={!submitting}
          placeholder="e.g. Whether the side-product profile changes at scale."
          placeholderTextColor="#999"
        />
      </View>

      <Pressable
        onPress={() => void handleSubmit()}
        disabled={!canSubmit}
        style={[styles.submit, canSubmit ? styles.submitEnabled : styles.submitDisabled]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Saving…' : 'Save hypothesis'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '700' },
  helpHeader: { fontSize: 13, color: '#555', lineHeight: 18 },
  error: { color: '#dc2626', fontSize: 13 },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 6,
    padding: 12,
    minHeight: 90,
    textAlignVertical: 'top',
    fontSize: 15,
  },
  submit: { padding: 16, borderRadius: 6, marginTop: 8 },
  submitEnabled: { backgroundColor: '#0066cc' },
  submitDisabled: { backgroundColor: '#cbd5e1' },
  submitLabel: {
    color: 'white',
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 16,
  },
});
