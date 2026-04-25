import pino from 'pino';

export interface LoggerInit {
  serviceName: string;
  level?: pino.LevelWithSilent;
}

const VALID_LEVELS: ReadonlyArray<pino.LevelWithSilent> = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

function resolveLevel(explicit?: pino.LevelWithSilent): pino.LevelWithSilent {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv === undefined || fromEnv === '') return 'info';
  if ((VALID_LEVELS as readonly string[]).includes(fromEnv)) return fromEnv as pino.LevelWithSilent;
  throw new Error(
    `Invalid LOG_LEVEL=${JSON.stringify(fromEnv)}; must be one of ${VALID_LEVELS.join('|')}`,
  );
}

/**
 * Create a structured logger.
 *
 * Level resolution: explicit `init.level` > LOG_LEVEL env var > 'info' default.
 * Invalid LOG_LEVEL values throw at construction (not at first log call).
 *
 * Output is JSON to stdout (Grafana / log aggregators ingest this directly).
 * Timestamps use ISO 8601 with offset (matches @cpa/schemas Iso8601 contract).
 */
export function createLogger(init: LoggerInit): pino.Logger {
  return pino({
    name: init.serviceName,
    level: resolveLevel(init.level),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
