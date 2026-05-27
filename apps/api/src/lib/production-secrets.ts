const DEV_SECRET_VALUES = new Set([
  'dev-only-32-bytes-of-entropy-pad!',
  'dev-only-signup-verification-pad!!',
]);

interface SecretOptions {
  devFallback: string;
  minLength?: number;
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readSecretEnv(name: string, options: SecretOptions): string {
  const minLength = options.minLength ?? 32;
  const value = readEnv(name);

  if (!isProduction()) return value ?? options.devFallback;

  if (!value) {
    throw new Error(`${name} is required in production.`);
  }

  if (DEV_SECRET_VALUES.has(value)) {
    throw new Error(`${name} must not use a development fallback in production.`);
  }

  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters in production.`);
  }

  return value;
}

export function assertDistinctProductionSecrets(
  firstName: string,
  firstValue: string,
  secondName: string,
  secondValue: string,
): void {
  if (!isProduction()) return;
  if (firstValue === secondValue) {
    throw new Error(`${firstName} and ${secondName} must be different in production.`);
  }
}
