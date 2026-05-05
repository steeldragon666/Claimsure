export type RifSeverity = 'high' | 'medium' | 'low';

export interface RifAlertInput {
  severity: RifSeverity;
  source: string;
  summary: string;
  url: string;
}

export interface RifAlertChannels {
  sendToPagerDuty: (payload: RifAlertInput) => Promise<void>;
  sendToSentry: (payload: RifAlertInput) => Promise<void>;
  sendToEmailDigest: (payload: RifAlertInput) => Promise<void>;
}

const ROUTING: Record<RifSeverity, (keyof RifAlertChannels)[]> = {
  high: ['sendToPagerDuty', 'sendToSentry'],
  medium: ['sendToSentry', 'sendToEmailDigest'],
  low: ['sendToEmailDigest'],
};

export async function sendRifAlert(
  input: RifAlertInput,
  channels: RifAlertChannels,
): Promise<void> {
  const dispatched = ROUTING[input.severity].map((fn) => channels[fn](input));
  await Promise.all(dispatched);
}
