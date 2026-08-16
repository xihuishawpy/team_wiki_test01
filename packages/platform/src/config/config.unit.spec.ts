import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('returns only API-safe configuration even when worker secrets are present', () => {
    const config = loadConfig({
      APP_ROLE: 'api',
      DATABASE_URL: 'postgres://app:password@db.internal/team_wiki',
      GITHUB_PUBLISHER_PRIVATE_KEY: 'must-not-escape',
      MODEL_API_KEY: 'must-not-escape',
    });

    expect(config).toEqual({
      common: {
        role: 'api',
        environment: 'development',
        databaseUrl: 'postgres://app:password@db.internal/team_wiki',
        logLevel: 'info',
        pollIntervalMs: 1_000,
      },
      api: {
        port: 3000,
        githubConfigured: false,
        modelConfigured: false,
      },
    });
    expect(JSON.stringify(config)).not.toContain('must-not-escape');
  });

  it('fails closed with configuration names but never values', () => {
    const secret = 'postgres://private-value';

    expect(() => loadConfig({ APP_ROLE: 'api', DATABASE_URL: secret, PORT: 'invalid' })).toThrow(
      ConfigurationError,
    );

    try {
      loadConfig({ APP_ROLE: 'api', DATABASE_URL: secret, PORT: 'invalid' });
    } catch (error) {
      expect(String(error)).toContain('PORT');
      expect(String(error)).not.toContain(secret);
    }
  });
});
