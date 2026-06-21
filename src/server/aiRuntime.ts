import fs from 'fs';

export const DEFAULT_AI_API_URL = 'http://100.113.105.18:8080/v1';

const LOCAL_DOCKER_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const normalizeAiApiUrl = (rawUrl: string, isDocker: boolean): string => {
  if (!isDocker) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    if (!LOCAL_DOCKER_HOSTNAMES.has(parsed.hostname)) {
      return rawUrl;
    }

    parsed.hostname = 'host.docker.internal';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

export const getAiApiUrl = (options?: { isDocker?: boolean }): string => {
  const rawUrl = process.env.AI_API_URL || DEFAULT_AI_API_URL;
  const isDocker = options?.isDocker ?? fs.existsSync('/.dockerenv');
  return normalizeAiApiUrl(rawUrl, isDocker);
};
