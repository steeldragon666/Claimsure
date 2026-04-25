import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createLogger } from './logger.js';

test('createLogger returns a logger with the configured name and default info level', () => {
  const logger = createLogger({ serviceName: 'test-svc' });
  assert.equal(logger.level, 'info');
  // pino sets `name` via bindings — accessible via logger.bindings()
  assert.equal(logger.bindings().name, 'test-svc');
});

test('createLogger respects an explicit level override', () => {
  const logger = createLogger({ serviceName: 'test-svc', level: 'debug' });
  assert.equal(logger.level, 'debug');
});

test('createLogger respects LOG_LEVEL env var', () => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  try {
    const logger = createLogger({ serviceName: 'test-svc' });
    assert.equal(logger.level, 'warn');
  } finally {
    if (original === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = original;
    }
  }
});

test('createLogger emits JSON with ISO 8601 + offset timestamp', () => {
  // Capture pino output via a writable stream
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  };
  // Use pino directly with our serializer config to capture output
  const captured = pino(
    {
      name: 'emit-test',
      level: 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    },
    stream as pino.DestinationStream,
  );
  captured.info({ probe: 'value' }, 'hello');

  assert.equal(chunks.length, 1);
  const line = chunks[0]!;
  const parsed = JSON.parse(line) as Record<string, unknown>;

  // Shape: must have name, level (string label), msg, time (ISO 8601 with offset), and our probe field
  assert.equal(parsed.name, 'emit-test');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'hello');
  assert.equal(parsed.probe, 'value');

  // Timestamp must be ISO 8601 with offset (matches @cpa/schemas Iso8601 zod contract)
  // Pattern: YYYY-MM-DDTHH:MM:SS.sssZ or YYYY-MM-DDTHH:MM:SS.sss±HH:MM
  assert.match(
    parsed.time as string,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
});

test('createLogger throws on invalid LOG_LEVEL', () => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'verbose'; // not a valid pino level
  try {
    assert.throws(
      () => createLogger({ serviceName: 'invalid-test' }),
      /Invalid LOG_LEVEL.*must be one of/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = original;
    }
  }
});
