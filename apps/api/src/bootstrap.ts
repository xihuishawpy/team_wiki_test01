import { access } from 'node:fs/promises';

import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import {
  ReadinessChecker,
  staticDependencyProbe,
  type ApiConfig,
  type DependencyProbe,
} from '@team-wiki/platform';

import { AppModule } from './app.module.js';

export interface CreateApiApplicationOptions {
  readonly config: ApiConfig;
  readonly probes: readonly DependencyProbe[];
  readonly logger?: LoggerService | false;
  readonly webRoot?: string;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const readinessChecker = new ReadinessChecker([
    ...options.probes,
    staticDependencyProbe('github', options.config.api.githubConfigured),
    staticDependencyProbe('model', options.config.api.modelConfigured),
  ]);

  const application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(readinessChecker),
    new FastifyAdapter({
      bodyLimit: 1_048_576,
      trustProxy: false,
    }),
    { logger: options.logger ?? false },
  );
  application.useLogger(options.logger ?? false);

  await application.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
      },
    },
  });
  if (options.webRoot) {
    try {
      await access(options.webRoot);
      await application.register(fastifyStatic, {
        root: options.webRoot,
        prefix: '/',
      });
    } catch {
      // API-only startup is valid for development and tests before the web bundle is built.
    }
  }

  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  return application;
}
