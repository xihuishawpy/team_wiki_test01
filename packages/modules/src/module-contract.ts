export type ModuleName =
  | 'identity-access'
  | 'content-drafts'
  | 'publication'
  | 'github-sync'
  | 'taxonomy'
  | 'classification'
  | 'discovery'
  | 'audit'
  | 'platform-health';

export type AdapterPort =
  | 'postgres'
  | 'github-publisher'
  | 'immutable-content-reader'
  | 'classification-model'
  | 'object-storage';

export interface ModuleContract {
  readonly name: ModuleName;
  readonly owns: readonly string[];
  readonly moduleDependencies: readonly ModuleName[];
  readonly adapterPorts: readonly AdapterPort[];
}

export const moduleCatalog = [
  {
    name: 'identity-access',
    owns: ['users', 'roles', 'sessions', 'authorization-policies'],
    moduleDependencies: ['audit'],
    adapterPorts: ['postgres'],
  },
  {
    name: 'content-drafts',
    owns: ['drafts', 'draft-attachments', 'optimistic-locks'],
    moduleDependencies: ['identity-access'],
    adapterPorts: ['postgres', 'object-storage'],
  },
  {
    name: 'publication',
    owns: ['publish-requests', 'articles', 'article-versions'],
    moduleDependencies: ['content-drafts', 'audit'],
    adapterPorts: ['postgres', 'github-publisher'],
  },
  {
    name: 'github-sync',
    owns: ['webhook-inbox', 'external-version-reconciliation'],
    moduleDependencies: ['publication', 'discovery', 'classification'],
    adapterPorts: ['postgres', 'immutable-content-reader'],
  },
  {
    name: 'taxonomy',
    owns: ['content-types', 'topics', 'projects', 'taxonomy-versions'],
    moduleDependencies: ['identity-access', 'audit'],
    adapterPorts: ['postgres'],
  },
  {
    name: 'classification',
    owns: ['classification-jobs', 'classifications', 'classification-feedback'],
    moduleDependencies: ['taxonomy', 'audit'],
    adapterPorts: ['postgres', 'immutable-content-reader', 'classification-model'],
  },
  {
    name: 'discovery',
    owns: ['derived-search-index', 'article-list-projections'],
    moduleDependencies: ['publication', 'classification', 'identity-access'],
    adapterPorts: ['postgres'],
  },
  {
    name: 'audit',
    owns: ['append-only-audit-events'],
    moduleDependencies: [],
    adapterPorts: ['postgres'],
  },
  {
    name: 'platform-health',
    owns: ['dependency-health', 'queue-health'],
    moduleDependencies: [],
    adapterPorts: ['postgres'],
  },
] as const satisfies readonly ModuleContract[];
