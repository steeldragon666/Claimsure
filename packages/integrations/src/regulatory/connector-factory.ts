/**
 * P7 Theme D Task D.9 — Connector factory / registry.
 *
 * Dispatches based on `regulatory_source.parser_kind`.
 * D.13 will register concrete implementations; for now the factory
 * returns a stub that throws if an unregistered kind is requested.
 */

import type { ISourceConnector, RegulatorySourceRow } from './source-connector.js';

/**
 * Registry of source connectors keyed by parser_kind.
 * D.13 will register concrete implementations; for now the factory
 * returns a stub that throws if an unregistered kind is requested.
 */
const registry = new Map<string, ISourceConnector>();

/**
 * Register a connector for a given parser_kind.
 * Called by each concrete connector module on import.
 */
export function registerConnector(parserKind: string, connector: ISourceConnector): void {
  registry.set(parserKind, connector);
}

/**
 * Look up the connector for a source's parser_kind.
 * Throws if no connector is registered for the kind.
 */
export function getConnector(source: RegulatorySourceRow): ISourceConnector {
  const connector = registry.get(source.parser_kind);
  if (!connector) {
    throw new Error(
      `No connector registered for parser_kind '${source.parser_kind}'. ` +
        `Available: [${[...registry.keys()].join(', ')}]`,
    );
  }
  return connector;
}

/**
 * List all registered parser_kind values. Useful for diagnostics.
 */
export function registeredKinds(): string[] {
  return [...registry.keys()];
}
