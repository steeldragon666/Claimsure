import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export interface TracerInit {
  serviceName: string;
  serviceVersion: string;
}

/**
 * Initialise the OpenTelemetry tracer + auto-instrumentations.
 *
 * Reads GRAFANA_OTLP_ENDPOINT (e.g. https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp),
 * GRAFANA_OTLP_USERNAME, GRAFANA_OTLP_PASSWORD from env. If endpoint is unset, falls
 * back to the OTLPTraceExporter's own default (localhost:4318) — useful for unit
 * tests where a real collector isn't running.
 *
 * Returns the NodeSDK so callers can `await sdk.shutdown()` on graceful exit.
 */
export function startTracing(init: TracerInit): NodeSDK {
  // Surface internal OTel warnings + errors to stderr. Without this, exporter
  // failures (network, auth) retry silently. WARN level avoids spam from
  // routine debug-level diagnostics.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const endpoint = process.env.GRAFANA_OTLP_ENDPOINT;
  const username = process.env.GRAFANA_OTLP_USERNAME;
  const password = process.env.GRAFANA_OTLP_PASSWORD;

  const headers: Record<string, string> = {};
  if (username && password) {
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }

  const exporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })
    : new OTLPTraceExporter();

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: init.serviceName,
      [ATTR_SERVICE_VERSION]: init.serviceVersion,
    }),
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  return sdk;
}
