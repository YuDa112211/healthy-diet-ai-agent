export const DEFAULT_AI_API_URL = 'http://100.113.105.18:8080/v1';

export const getAiApiUrl = (): string => process.env.AI_API_URL || DEFAULT_AI_API_URL;
