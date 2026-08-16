import { createFakeExternalServer } from './server.js';

async function main(): Promise<void> {
  const server = await createFakeExternalServer({
    environment: process.env.NODE_ENV ?? 'development',
    enabled: process.env.ALLOW_FAKE_EXTERNAL === 'true',
  });
  const port = Number.parseInt(process.env.FAKE_EXTERNAL_PORT ?? '4010', 10);
  await server.listen({ host: '0.0.0.0', port });

  const shutdown = async (): Promise<void> => server.close();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ error_code: 'FAKE_EXTERNAL_STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
});
