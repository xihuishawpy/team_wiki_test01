import { afterEach, describe, expect, it } from 'vitest';

import { createFakeExternalServer } from './server.js';

describe('local external-service fake', () => {
  const servers: Array<Awaited<ReturnType<typeof createFakeExternalServer>>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  it('returns deterministic GitHub and model responses without echoing request content', async () => {
    const server = await createFakeExternalServer({ environment: 'test', enabled: true });
    servers.push(server);

    const tokenResponse = await server.inject({
      method: 'POST',
      url: '/app/installations/123/access_tokens',
    });
    expect(tokenResponse.statusCode).toBe(201);
    expect(tokenResponse.json()).toMatchObject({ token: 'local-fake-token' });

    const sensitiveInput = 'private article body';
    const modelResponse = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: sensitiveInput }] },
    });
    expect(modelResponse.statusCode).toBe(200);
    expect(modelResponse.body).not.toContain(sensitiveInput);
    expect(modelResponse.json()).toMatchObject({ object: 'chat.completion' });
  });

  it('refuses to run in production even when explicitly enabled', async () => {
    await expect(
      createFakeExternalServer({ environment: 'production', enabled: true }),
    ).rejects.toThrow('disabled in production');
  });

  it('rejects content writes made with reader credentials', async () => {
    const server = await createFakeExternalServer({ environment: 'test', enabled: true });
    servers.push(server);

    const response = await server.inject({
      method: 'PATCH',
      url: '/repos/acme/content/git/refs/heads/main',
      headers: { 'x-fake-app-role': 'reader' },
      payload: { sha: '0123456789abcdef' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error_code: 'CONTENTS_WRITE_FORBIDDEN' });
  });

  it.each([
    ['rate-limit', 429],
    ['unavailable', 503],
  ])('injects the %s failure scenario without leaking the request', async (scenario, status) => {
    const server = await createFakeExternalServer({ environment: 'test', enabled: true });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-fake-scenario': scenario },
      payload: { private: 'do-not-echo' },
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('do-not-echo');
  });
});
