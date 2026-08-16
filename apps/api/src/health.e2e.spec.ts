import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApiConfig, DependencyProbe } from '@team-wiki/platform';

import { createApiApplication } from './bootstrap.js';

const config: ApiConfig = {
  common: {
    role: 'api',
    environment: 'test',
    databaseUrl: 'postgres://unused-in-e2e',
    logLevel: 'error',
    pollIntervalMs: 1_000,
  },
  api: {
    port: 3000,
    githubConfigured: false,
    modelConfigured: false,
  },
};

const healthyProbe = (name: string, required: boolean): DependencyProbe => ({
  name,
  required,
  check: async () => ({ status: 'ok' }),
});

describe('health endpoints', () => {
  let application: INestApplication | undefined;

  afterEach(async () => {
    await application?.close();
  });

  it('keeps liveness independent from external dependencies', async () => {
    application = await createApiApplication({
      config,
      probes: [
        {
          name: 'database',
          required: true,
          check: async () => ({ status: 'unavailable', code: 'DATABASE_UNAVAILABLE' }),
        },
      ],
      logger: false,
    });

    await request(application.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('reports optional unconfigured dependencies as degraded without leaking configuration', async () => {
    application = await createApiApplication({
      config,
      probes: [healthyProbe('database', true), healthyProbe('migrations', true)],
      logger: false,
    });

    const response = await request(application.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({
      status: 'degraded',
      database: { status: 'ok' },
      github: { status: 'unconfigured' },
      model: { status: 'unconfigured' },
    });
    expect(JSON.stringify(response.body)).not.toContain(config.common.databaseUrl);
  });

  it('returns 503 when a required dependency is unavailable', async () => {
    application = await createApiApplication({
      config,
      probes: [
        {
          name: 'database',
          required: true,
          check: async () => ({ status: 'unavailable', code: 'DATABASE_UNAVAILABLE' }),
        },
        healthyProbe('migrations', true),
      ],
      logger: false,
    });

    const response = await request(application.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toEqual({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Required dependency unavailable.',
      request_id: expect.any(String),
    });
  });

  it('reports a configured but unavailable external dependency without making the API unready', async () => {
    application = await createApiApplication({
      config: { ...config, api: { ...config.api, githubConfigured: true } },
      probes: [
        healthyProbe('database', true),
        healthyProbe('migrations', true),
        {
          name: 'github',
          required: false,
          check: async () => ({ status: 'unavailable', code: 'GITHUB_UNAVAILABLE' }),
        },
      ],
      logger: false,
    });

    const response = await request(application.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body).toMatchObject({
      status: 'degraded',
      github: { status: 'unavailable', error_code: 'GITHUB_UNAVAILABLE' },
    });
  });

  it('serves the built browser shell from the API artifact', async () => {
    application = await createApiApplication({
      config,
      probes: [healthyProbe('database', true), healthyProbe('migrations', true)],
      logger: false,
      webRoot: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    });

    const response = await request(application.getHttpServer()).get('/').expect(200);
    expect(response.text).toContain('<title>Team Wiki</title>');
  });
});
import { fileURLToPath } from 'node:url';
