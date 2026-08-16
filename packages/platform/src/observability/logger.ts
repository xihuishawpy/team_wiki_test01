import pino, { type Logger } from 'pino';

import type { CommonConfig } from '../config/config.js';

const redactPaths = [
  '*.password',
  '*.token',
  '*.authorization',
  '*.cookie',
  '*.secret',
  '*.privateKey',
  '*.apiKey',
  'password',
  'token',
  'authorization',
  'cookie',
  'secret',
  'privateKey',
  'apiKey',
];

function safeMessage(message: unknown): string {
  return typeof message === 'string' ? message : 'non_string_log_message';
}

export function createLogger(config: CommonConfig): Logger {
  return pino({
    level: config.logLevel,
    base: {
      service: 'team-wiki',
      role: config.role,
      environment: config.environment,
    },
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
  });
}

export class NestStructuredLogger {
  public constructor(private readonly logger: Logger) {}

  public log(message: unknown, context?: string): void {
    this.logger.info({ context }, safeMessage(message));
  }

  public error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(
      { context, error_code: trace ? 'NEST_ERROR_WITH_TRACE' : 'NEST_ERROR' },
      safeMessage(message),
    );
  }

  public warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, safeMessage(message));
  }

  public debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, safeMessage(message));
  }

  public verbose(message: unknown, context?: string): void {
    this.logger.debug({ context }, safeMessage(message));
  }
}
