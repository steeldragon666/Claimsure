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
 * GRAFANA_OTLP_USERNAME, GRAFANA_OTLP_PASSWORD from env.
 *
 * NO-OP MODE: if GRAFANA_OTLP_ENDPOINT is unset, returns an inert NodeSDK
 * without starting any exporter. The previous behaviour — falling back to
 * the OTLPTraceExporter's localhost:4318 default — crashed any deployment
 * without a sidecar collector (Railway, Fly, Cloud Run, etc.) because the
 * auto-instrumentation patched pg-boss → pg-boss's instrumented pg client
 * propagated the exporter's ECONNREFUSED on first DB call.
 *
 * Also respects `OTEL_SDK_DISABLED=true` as an override for environments
 * that want to force-disable OTel even when an endpoint is configured.
 *
 * Returns the NodeSDK so callers can `await sdk.shutdown()` on graceful exit.
 */
export function startTracing(init: TracerInit): NodeSDK {
  const endpoint = process.env.GRAFANA_OTLP_ENDPOINT;
  const disabled = process.env.OTEL_SDK_DISABLED === 'true';

  // No collector → no exporter → no SDK start. Returning an unstarted NodeSDK
  // keeps the return-type contract (callers can still `await sdk.shutdown()`,
  // which is a no-op on an unstarted SDK).
  if (!endpoint || disabled) {
    return new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: init.serviceName,
        [ATTR_SERVICE_VERSION]: init.serviceVersion,
      }),
    });
  }

  // Surface internal OTel warnings + errors to stderr. Without this, exporter
  // failures (network, auth) retry silently. WARN level avoids spam from
  // routine debug-level diagnostics. Only meaningful when SDK actually runs.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const username = process.env.GRAFANA_OTLP_USERNAME;
  const password = process.env.GRAFANA_OTLP_PASSWORD;

  const headers: Record<string, string> = {};
  if (username && password) {
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }

  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });

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
