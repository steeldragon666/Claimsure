export interface PublicBaseUrlLogger {
  warn: (message: string) => void;
}

interface PublicBaseUrlOptions {
  logger?: PublicBaseUrlLogger;
}

let cachedPublicBaseUrl: string | null = null;

function normalizedUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getPublicBaseUrl(options: PublicBaseUrlOptions = {}): string {
  if (cachedPublicBaseUrl) return cachedPublicBaseUrl;

  const logger = options.logger ?? console;
  const publicBaseUrl = readEnv('PUBLIC_BASE_URL');
  if (publicBaseUrl) {
    cachedPublicBaseUrl = normalizedUrl(publicBaseUrl);
    return cachedPublicBaseUrl;
  }

  const appBaseUrl = readEnv('APP_BASE_URL');
  if (appBaseUrl) {
    logger.warn('APP_BASE_URL is deprecated for public links; set PUBLIC_BASE_URL instead.');
    cachedPublicBaseUrl = normalizedUrl(appBaseUrl);
    return cachedPublicBaseUrl;
  }

  const webBaseUrl = readEnv('WEB_BASE_URL');
  if (webBaseUrl) {
    logger.warn('WEB_BASE_URL is deprecated for public links; set PUBLIC_BASE_URL instead.');
    cachedPublicBaseUrl = normalizedUrl(webBaseUrl);
    return cachedPublicBaseUrl;
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'PUBLIC_BASE_URL is required in production for user-facing URLs. Set it to the public site origin, for example https://archiveone.com.au.',
    );
  }

  cachedPublicBaseUrl = 'http://localhost:5173';
  return cachedPublicBaseUrl;
}

export function publicUrl(path: string, options: PublicBaseUrlOptions = {}): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${getPublicBaseUrl(options)}${cleanPath}`;
}

export function resetPublicBaseUrlForTesting(): void {
  cachedPublicBaseUrl = null;
}
