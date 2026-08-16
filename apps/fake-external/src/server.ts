import Fastify, { type FastifyInstance } from 'fastify';

export interface FakeExternalServerOptions {
  readonly environment: string;
  readonly enabled: boolean;
}

export async function createFakeExternalServer(
  options: FakeExternalServerOptions,
): Promise<FastifyInstance> {
  if (options.environment === 'production') {
    throw new Error('Local external-service fake is disabled in production');
  }
  if (!options.enabled) {
    throw new Error('Local external-service fake requires explicit enablement');
  }

  const server = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  server.get('/health/live', () => ({ status: 'ok' }));
  server.post('/app/installations/:installationId/access_tokens', (request, reply) => {
    if (request.headers['x-fake-scenario'] === 'rate-limit') {
      void reply.status(429);
      return { error_code: 'RATE_LIMITED' };
    }
    if (request.headers['x-fake-scenario'] === 'unavailable') {
      void reply.status(503);
      return { error_code: 'UPSTREAM_UNAVAILABLE' };
    }
    void reply.status(201);
    return {
      token: 'local-fake-token',
      expires_at: '2099-01-01T00:00:00Z',
      permissions: { contents: 'write' },
      repository_selection: 'selected',
    };
  });
  server.patch('/repos/:owner/:repository/git/refs/*', (request, reply) => {
    if (request.headers['x-fake-app-role'] !== 'publisher') {
      void reply.status(403);
      return { error_code: 'CONTENTS_WRITE_FORBIDDEN' };
    }
    return { ref: 'refs/heads/main', object: { sha: '0123456789abcdef', type: 'commit' } };
  });
  server.post('/v1/chat/completions', (request, reply) => {
    if (request.headers['x-fake-scenario'] === 'rate-limit') {
      void reply.status(429);
      return { error_code: 'RATE_LIMITED' };
    }
    if (request.headers['x-fake-scenario'] === 'unavailable') {
      void reply.status(503);
      return { error_code: 'UPSTREAM_UNAVAILABLE' };
    }
    return {
      id: 'fake-classification-1',
      object: 'chat.completion',
      created: 0,
      model: 'local-deterministic-classifier',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              content_type_id: '00000000-0000-0000-0000-000000000001',
              topic_ids: [],
              project_id: null,
              tags: ['local-fake', 'needs-review'],
              confidence: 0,
              reason: '本地固定响应，不代表真实分类结果',
            }),
          },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });

  await server.ready();
  return server;
}
