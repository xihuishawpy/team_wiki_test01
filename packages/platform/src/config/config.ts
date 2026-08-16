import { z } from 'zod';

export type ApplicationRole = 'api' | 'publish' | 'classify' | 'reconcile';

export interface CommonConfig {
  readonly role: ApplicationRole;
  readonly environment: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly pollIntervalMs: number;
}

export interface ApiConfig {
  readonly common: CommonConfig & { readonly role: 'api' };
  readonly api: {
    readonly port: number;
    readonly githubConfigured: boolean;
    readonly modelConfigured: boolean;
  };
}

export interface PublishWorkerConfig {
  readonly common: CommonConfig & { readonly role: 'publish' };
  readonly github:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly appId: string;
        readonly installationId: string;
        readonly privateKey: string;
        readonly owner: string;
        readonly repository: string;
        readonly branch: string;
      };
}

export interface ClassifyWorkerConfig {
  readonly common: CommonConfig & { readonly role: 'classify' };
  readonly github:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly appId: string;
        readonly installationId: string;
        readonly privateKey: string;
        readonly owner: string;
        readonly repository: string;
      };
  readonly model:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly baseUrl: string;
        readonly name: string;
        readonly apiKey: string;
      };
}

export interface ReconcileWorkerConfig {
  readonly common: CommonConfig & { readonly role: 'reconcile' };
  readonly github:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly appId: string;
        readonly installationId: string;
        readonly privateKey: string;
        readonly owner: string;
        readonly repository: string;
        readonly branch: string;
      };
}

export type ApplicationConfig =
  ApiConfig | PublishWorkerConfig | ClassifyWorkerConfig | ReconcileWorkerConfig;

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  APP_ROLE: z.enum(['api', 'publish', 'classify', 'reconcile']).default('api'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  GITHUB_PUBLISH_ENABLED: booleanFromEnvironment,
  GITHUB_READ_ENABLED: booleanFromEnvironment,
  MODEL_ENABLED: booleanFromEnvironment,
  GITHUB_PUBLISHER_APP_ID: z.string().optional(),
  GITHUB_PUBLISHER_INSTALLATION_ID: z.string().optional(),
  GITHUB_PUBLISHER_PRIVATE_KEY: z.string().optional(),
  GITHUB_READER_APP_ID: z.string().optional(),
  GITHUB_READER_INSTALLATION_ID: z.string().optional(),
  GITHUB_READER_PRIVATE_KEY: z.string().optional(),
  GITHUB_CONTENT_OWNER: z.string().optional(),
  GITHUB_CONTENT_REPO: z.string().optional(),
  GITHUB_CONTENT_BRANCH: z.string().optional(),
  MODEL_BASE_URL: z.url().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_API_KEY: z.string().optional(),
});

type ParsedEnvironment = z.infer<typeof environmentSchema>;
type EnvironmentInput = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  public constructor(readonly invalidNames: readonly string[]) {
    super(`Invalid configuration: ${invalidNames.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

function requireNames(
  environment: ParsedEnvironment,
  names: readonly (keyof ParsedEnvironment)[],
): void {
  const missing = names.filter((name) => {
    const value = environment[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }
}

function commonConfig(environment: ParsedEnvironment): CommonConfig {
  return {
    role: environment.APP_ROLE,
    environment: environment.NODE_ENV,
    databaseUrl: environment.DATABASE_URL,
    logLevel: environment.LOG_LEVEL,
    pollIntervalMs: environment.WORKER_POLL_INTERVAL_MS,
  };
}

function publisherConfig(environment: ParsedEnvironment): PublishWorkerConfig['github'] {
  if (!environment.GITHUB_PUBLISH_ENABLED) {
    return { enabled: false };
  }

  requireNames(environment, [
    'GITHUB_PUBLISHER_APP_ID',
    'GITHUB_PUBLISHER_INSTALLATION_ID',
    'GITHUB_PUBLISHER_PRIVATE_KEY',
    'GITHUB_CONTENT_OWNER',
    'GITHUB_CONTENT_REPO',
    'GITHUB_CONTENT_BRANCH',
  ]);

  return {
    enabled: true,
    appId: environment.GITHUB_PUBLISHER_APP_ID!,
    installationId: environment.GITHUB_PUBLISHER_INSTALLATION_ID!,
    privateKey: environment.GITHUB_PUBLISHER_PRIVATE_KEY!,
    owner: environment.GITHUB_CONTENT_OWNER!,
    repository: environment.GITHUB_CONTENT_REPO!,
    branch: environment.GITHUB_CONTENT_BRANCH!,
  };
}

function readerConfig(
  environment: ParsedEnvironment,
): ClassifyWorkerConfig['github'] | ReconcileWorkerConfig['github'] {
  if (!environment.GITHUB_READ_ENABLED) {
    return { enabled: false };
  }

  requireNames(environment, [
    'GITHUB_READER_APP_ID',
    'GITHUB_READER_INSTALLATION_ID',
    'GITHUB_READER_PRIVATE_KEY',
    'GITHUB_CONTENT_OWNER',
    'GITHUB_CONTENT_REPO',
  ]);

  const shared = {
    enabled: true as const,
    appId: environment.GITHUB_READER_APP_ID!,
    installationId: environment.GITHUB_READER_INSTALLATION_ID!,
    privateKey: environment.GITHUB_READER_PRIVATE_KEY!,
    owner: environment.GITHUB_CONTENT_OWNER!,
    repository: environment.GITHUB_CONTENT_REPO!,
  };

  if (environment.APP_ROLE === 'reconcile') {
    requireNames(environment, ['GITHUB_CONTENT_BRANCH']);
    return { ...shared, branch: environment.GITHUB_CONTENT_BRANCH! };
  }

  return shared;
}

function modelConfig(environment: ParsedEnvironment): ClassifyWorkerConfig['model'] {
  if (!environment.MODEL_ENABLED) {
    return { enabled: false };
  }

  requireNames(environment, ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY']);
  return {
    enabled: true,
    baseUrl: environment.MODEL_BASE_URL!,
    name: environment.MODEL_NAME!,
    apiKey: environment.MODEL_API_KEY!,
  };
}

export function loadConfig(input: EnvironmentInput = process.env): ApplicationConfig {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const invalidNames = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigurationError(invalidNames);
  }

  const environment = result.data;
  const common = commonConfig(environment);
  switch (environment.APP_ROLE) {
    case 'api':
      return {
        common: { ...common, role: 'api' },
        api: {
          port: environment.PORT,
          githubConfigured: environment.GITHUB_PUBLISH_ENABLED || environment.GITHUB_READ_ENABLED,
          modelConfigured: environment.MODEL_ENABLED,
        },
      };
    case 'publish':
      return {
        common: { ...common, role: 'publish' },
        github: publisherConfig(environment),
      };
    case 'classify':
      return {
        common: { ...common, role: 'classify' },
        github: readerConfig(environment),
        model: modelConfig(environment),
      };
    case 'reconcile':
      return {
        common: { ...common, role: 'reconcile' },
        github: readerConfig(environment) as ReconcileWorkerConfig['github'],
      };
  }
}
