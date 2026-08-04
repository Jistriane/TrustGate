import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Pretty-printing spawns a worker thread; opt in explicitly for local dev
  // only. Every other environment (test, production) gets plain structured
  // JSON — this also keeps Jest from warning about open handles.
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});
