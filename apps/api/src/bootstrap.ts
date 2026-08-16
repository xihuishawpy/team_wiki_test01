import { stat } from 'node:fs/promises';

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

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const probeNames = new Set(options.probes.map((probe) => probe.name));
  const probes = [...options.probes];
  if (!probeNames.has('github')) {
    probes.push(staticDependencyProbe('github', options.config.api.githubConfigured));
  }
  if (!probeNames.has('model')) {
    probes.push(staticDependencyProbe('model', options.config.api.modelConfigured));
  }
  const readinessChecker = new ReadinessChecker(probes);

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
  if (options.webRoot && (await directoryExists(options.webRoot))) {
    await application.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
    });
  }

  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  return application;
}
