import type { Response } from 'express';

export const formatSSEMessage = (data: object, eventName?: string): string => {
  const normalizedEventName =
    typeof eventName === 'string' && eventName.trim().length > 0 ? eventName.trim() : '';

  return `${normalizedEventName ? `event: ${normalizedEventName}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
};

export const sendSSE = (
  res: Pick<Response, 'write'>,
  data: object,
  eventName?: string
): void => {
  res.write(formatSSEMessage(data, eventName));
};
