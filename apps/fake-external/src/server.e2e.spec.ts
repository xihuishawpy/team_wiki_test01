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
});
