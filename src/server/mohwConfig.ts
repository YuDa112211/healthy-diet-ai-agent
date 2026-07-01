import type { AgentConfig } from '../config/agentConfig';

const parseOptionalBooleanEnv = (value: string | undefined): boolean | undefined => {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  return undefined;
};

export const resolveMohwNewsSyncEnabled = (
  configMohwEnabled: AgentConfig['features']['mohwEnabled'],
  envValue?: string | null,
): boolean => {
  const candidateEnvValue =
    typeof envValue === 'undefined' ? process.env.MOHW_NEWS_SYNC_ENABLED : envValue || undefined;
  const envOverride = parseOptionalBooleanEnv(candidateEnvValue);
  if (typeof envOverride === 'boolean') {
    return envOverride;
  }

  return configMohwEnabled;
};
