import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AgentCommand,
  ConnectorCapabilities,
  ProfileVersion,
  RecoveryManifest,
  RestoreScope,
  PostgresEvidence,
  DockerEvidence,
  DockerCatalog,
  DockerSelection,
} from '@apbackup/contracts';

export const executionStatus = pgEnum('execution_status', [
  'aguardando',
  'verificando',
  'capturando',
  'enviando',
  'verificando_destino',
  'concluida',
  'falhas_parciais',
  'falhou',
  'cancelada',
  'exige_intervencao',
]);
export const operationKind = pgEnum('operation_kind', [
  'backup',
  'restore',
  'verify',
  'retention',
  'catalog_export',
  'recovery_drill',
]);
export const destinationStatus = pgEnum('destination_status', [
  'aguardando_configuracao',
  'ativo',
  'indisponivel',
  'desabilitado',
]);
export const destinationKind = pgEnum('destination_kind', [
  'local',
  'sftp',
  'smb',
  'google_drive',
  's3',
  'pbs',
]);
export const resourceKind = pgEnum('resource_kind', [
  'postgresql',
  'files',
  'compose',
  'swarm',
  'dokploy',
  'redis',
  'supabase_schema',
  'supabase_auth',
  'supabase_storage',
  'vm',
  'proxmox_host',
  'pbs_configuration',
]);
export const role = pgEnum('platform_role', [
  'administrator',
  'backup_operator',
  'restore_operator',
  'viewer',
]);
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const identity = () => ({ id: uuid('id').primaryKey().defaultRandom(), ...timestamps() });
export const organizations = pgTable(
  'organizations',
  { ...identity(), name: text('name').notNull() },
  (t) => [check('organization_name_nonempty', sql`length(trim(${t.name})) > 0`)],
);
const scoped = () => ({
  ...identity(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
});
const tenantKey = (t: { organizationId: AnyPgColumn; id: AnyPgColumn }) =>
  unique().on(t.organizationId, t.id);

// Authentication behavior, sessions and MFA follow in migration 0004. One identity source.
export const users = pgTable(
  'users',
  {
    ...identity(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  },
  (t) => [
    check(
      'user_email_normalized',
      sql`${t.email} = lower(trim(${t.email})) AND position('@' in ${t.email}) > 1`,
    ),
  ],
);
export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    ...scoped(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: role('role').notNull().default('viewer'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    ...identity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expiry_idx').on(t.expiresAt),
  ],
);
export const authAccounts = pgTable(
  'auth_accounts',
  {
    ...identity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    scope: text('scope'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.providerId, t.accountId), index('auth_accounts_user_idx').on(t.userId)],
);
export const authVerifications = pgTable(
  'auth_verifications',
  {
    ...identity(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);
export const authTwoFactors = pgTable('auth_two_factors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(false),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});
export const authRateLimits = pgTable('auth_rate_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// Ciphertext only. The key reference points to custody outside this database.
export const secretReferences = pgTable(
  'secret_references',
  {
    ...scoped(),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyReference: text('key_reference').notNull(),
    algorithm: text('algorithm').notNull().default('aes-256-gcm'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.name, t.version),
    check(
      'secret_reference_envelope',
      sql`length(${t.ciphertext}) > 0 AND length(${t.keyReference}) > 0 AND ${t.version} > 0`,
    ),
  ],
);
export const servers = pgTable(
  'servers',
  {
    ...scoped(),
    name: text('name').notNull(),
    externalIdentity: text('external_identity').notNull(),
    hostname: text('hostname'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.externalIdentity),
    index('servers_org_name_idx').on(t.organizationId, t.name),
    check('server_identity_nonempty', sql`length(trim(${t.externalIdentity})) > 0`),
  ],
);
export const agents = pgTable(
  'agents',
  {
    ...scoped(),
    serverId: uuid('server_id').notNull(),
    externalIdentity: text('external_identity').notNull(),
    publicKey: text('public_key').notNull(),
    identityDigest: text('identity_digest').unique(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.externalIdentity),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    index('agents_server_idx').on(t.organizationId, t.serverId),
  ],
);
export const connections = pgTable(
  'connections',
  {
    ...scoped(),
    serverId: uuid('server_id').notNull(),
    kind: text('kind').notNull(),
    endpoint: text('endpoint').notNull(),
    secretReferenceId: uuid('secret_reference_id'),
    configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.secretReferenceId],
      foreignColumns: [secretReferences.organizationId, secretReferences.id],
    }),
    index('connections_server_idx').on(t.organizationId, t.serverId),
  ],
);
export const resources = pgTable(
  'resources',
  {
    ...scoped(),
    serverId: uuid('server_id').notNull(),
    kind: resourceKind('kind').notNull(),
    name: text('name').notNull(),
    externalIdentity: text('external_identity').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.serverId, t.kind, t.externalIdentity),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    index('resources_server_idx').on(t.organizationId, t.serverId),
  ],
);
export const resourceDependencies = pgTable(
  'resource_dependencies',
  {
    ...scoped(),
    resourceId: uuid('resource_id').notNull(),
    dependsOnResourceId: uuid('depends_on_resource_id').notNull(),
    shared: boolean('shared').notNull().default(false),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.resourceId, t.dependsOnResourceId),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.dependsOnResourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    check('resource_not_self_dependent', sql`${t.resourceId} <> ${t.dependsOnResourceId}`),
  ],
);
export const systemProfiles = pgTable(
  'system_profiles',
  {
    ...scoped(),
    serverId: uuid('server_id').notNull(),
    name: text('name').notNull(),
    externalIdentity: text('external_identity').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.serverId, t.externalIdentity),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
  ],
);
export const profileVersions = pgTable(
  'profile_versions',
  {
    ...scoped(),
    profileId: uuid('profile_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<ProfileVersion>().notNull(),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.profileId, t.version),
    foreignKey({
      columns: [t.organizationId, t.profileId],
      foreignColumns: [systemProfiles.organizationId, systemProfiles.id],
    }),
    check('profile_version_positive', sql`${t.version} > 0`),
  ],
);
export const profileResources = pgTable(
  'profile_resources',
  {
    ...scoped(),
    profileVersionId: uuid('profile_version_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    required: boolean('required').notNull().default(true),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.profileVersionId, t.resourceId),
    foreignKey({
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
  ],
);
export const destinations = pgTable(
  'destinations',
  {
    ...scoped(),
    name: text('name').notNull(),
    kind: destinationKind('kind'),
    host: text('host'),
    status: destinationStatus('status').notNull().default('aguardando_configuracao'),
    rootPath: text('root_path'),
    credentialId: uuid('credential_id'),
    configuration: jsonb('configuration'),
    configurationRevision: integer('configuration_revision').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.credentialId],
      foreignColumns: [secretReferences.organizationId, secretReferences.id],
    }),
    check(
      'active_destination_configured',
      sql`${t.status} <> 'ativo' OR (${t.kind} IS NOT NULL AND nullif(trim(${t.rootPath}), '') IS NOT NULL AND ${t.credentialId} IS NOT NULL)`,
    ),
  ],
);
export const connectorCapabilities = pgTable(
  'connector_capabilities',
  {
    ...scoped(),
    destinationId: uuid('destination_id').notNull(),
    connectorName: text('connector_name').notNull(),
    connectorVersion: text('connector_version').notNull(),
    capabilities: jsonb('capabilities').$type<ConnectorCapabilities>().notNull(),
    configurationRevision: integer('configuration_revision').notNull().default(1),
    assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    tenantKey(t),
    unique('connector_capabilities_revision_unique').on(
      t.organizationId,
      t.destinationId,
      t.connectorVersion,
      t.configurationRevision,
    ),
    foreignKey({
      columns: [t.organizationId, t.destinationId],
      foreignColumns: [destinations.organizationId, destinations.id],
    }),
  ],
);
export const repositories = pgTable(
  'repositories',
  {
    ...scoped(),
    destinationId: uuid('destination_id').notNull(),
    externalIdentity: text('external_identity').notNull(),
    engine: text('engine'),
    captureCredentialId: uuid('capture_credential_id'),
    maintenanceCredentialId: uuid('maintenance_credential_id'),
    nativeRepositoryId: text('native_repository_id'),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.destinationId, t.externalIdentity),
    foreignKey({
      columns: [t.organizationId, t.destinationId],
      foreignColumns: [destinations.organizationId, destinations.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.captureCredentialId],
      foreignColumns: [secretReferences.organizationId, secretReferences.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.maintenanceCredentialId],
      foreignColumns: [secretReferences.organizationId, secretReferences.id],
    }),
  ],
);
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    ...scoped(),
    name: text('name').notNull(),
    days: integer('days').notNull().default(7),
    evidenceDays: integer('evidence_days').notNull().default(90),
    protectLastVerified: boolean('protect_last_verified').notNull().default(true),
  },
  (t) => [
    tenantKey(t),
    check('retention_positive_days', sql`${t.days} > 0 AND ${t.evidenceDays} > 0`),
    check('retention_protect_last_verified', sql`${t.protectLastVerified} = true`),
  ],
);
export const plans = pgTable(
  'plans',
  {
    ...scoped(),
    serverId: uuid('server_id').notNull(),
    profileVersionId: uuid('profile_version_id'),
    retentionPolicyId: uuid('retention_policy_id'),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.retentionPolicyId],
      foreignColumns: [retentionPolicies.organizationId, retentionPolicies.id],
    }),
    index('plans_server_idx').on(t.organizationId, t.serverId),
  ],
);
export const planResources = pgTable(
  'plan_resources',
  { ...scoped(), planId: uuid('plan_id').notNull(), resourceId: uuid('resource_id').notNull() },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.planId, t.resourceId),
    foreignKey({
      columns: [t.organizationId, t.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
  ],
);
export const planDestinations = pgTable(
  'plan_destinations',
  {
    ...scoped(),
    planId: uuid('plan_id').notNull(),
    repositoryId: uuid('repository_id').notNull(),
    required: boolean('required').notNull().default(true),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.planId, t.repositoryId),
    foreignKey({
      columns: [t.organizationId, t.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.repositoryId],
      foreignColumns: [repositories.organizationId, repositories.id],
    }),
  ],
);
export const schedules = pgTable(
  'schedules',
  {
    ...scoped(),
    planId: uuid('plan_id').notNull(),
    localTime: time('local_time').notNull().default('03:00:00'),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    enabled: boolean('enabled').notNull().default(false),
    lastScheduledAt: timestamp('last_scheduled_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.planId, t.localTime, t.timezone),
    foreignKey({
      columns: [t.organizationId, t.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    check('schedule_time_in_day', sql`${t.localTime} < '24:00:00'::time`),
    index('schedules_enabled_idx').on(t.enabled, t.localTime),
  ],
);
export const executions = pgTable(
  'executions',
  {
    ...scoped(),
    planId: uuid('plan_id'),
    profileVersionId: uuid('profile_version_id'),
    agentId: uuid('agent_id'),
    kind: operationKind('kind').notNull(),
    status: executionStatus('status').notNull().default('aguardando'),
    idempotencyKey: text('idempotency_key').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.idempotencyKey),
    unique().on(t.organizationId, t.planId, t.scheduledFor),
    foreignKey({
      columns: [t.organizationId, t.planId],
      foreignColumns: [plans.organizationId, plans.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    index('executions_org_status_created_idx').on(t.organizationId, t.status, t.createdAt),
    index('executions_plan_created_idx').on(t.organizationId, t.planId, t.createdAt),
    foreignKey({
      name: 'executions_profile_version_fk',
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    index('executions_profile_version_idx').on(t.organizationId, t.profileVersionId),
  ],
);
export const executionSteps = pgTable(
  'execution_steps',
  {
    ...scoped(),
    executionId: uuid('execution_id').notNull(),
    key: text('key').notNull(),
    position: integer('position').notNull(),
    status: executionStatus('status').notNull().default('aguardando'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique('execution_steps_execution_identity_unique').on(t.organizationId, t.executionId, t.id),
    unique().on(t.organizationId, t.executionId, t.key),
    unique().on(t.organizationId, t.executionId, t.position),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    check('step_position_nonnegative', sql`${t.position} >= 0`),
  ],
);
export const attempts = pgTable(
  'attempts',
  {
    ...scoped(),
    stepId: uuid('step_id').notNull(),
    number: integer('number').notNull(),
    status: executionStatus('status').notNull().default('aguardando'),
    agentJournalReference: text('agent_journal_reference'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.stepId, t.number),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    check('attempt_number_positive', sql`${t.number} > 0`),
  ],
);
export const leases = pgTable(
  'leases',
  {
    ...scoped(),
    resourceId: uuid('resource_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    holder: uuid('holder').notNull(),
    fencingToken: bigint('fencing_token', { mode: 'bigint' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.resourceId),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    index('leases_expiry_idx').on(t.expiresAt),
    check('lease_fencing_positive', sql`${t.fencingToken} > 0`),
  ],
);
export const executionEvents = pgTable(
  'execution_events',
  {
    ...scoped(),
    executionId: uuid('execution_id').notNull(),
    stepId: uuid('step_id'),
    level: text('level').notNull(),
    code: text('code').notNull(),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    foreignKey({
      name: 'execution_events_execution_step_fk',
      columns: [t.organizationId, t.executionId, t.stepId],
      foreignColumns: [
        executionSteps.organizationId,
        executionSteps.executionId,
        executionSteps.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('execution_events_step_idx').on(t.organizationId, t.executionId, t.stepId),
    index('events_execution_created_idx').on(t.organizationId, t.executionId, t.createdAt),
  ],
);
export const recoveryPoints = pgTable(
  'recovery_points',
  {
    ...scoped(),
    executionId: uuid('execution_id').notNull(),
    serverId: uuid('server_id').notNull(),
    profileVersionId: uuid('profile_version_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('incomplete'),
    protectedUntil: timestamp('protected_until', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    index('points_profile_capture_idx').on(t.organizationId, t.profileVersionId, t.capturedAt),
    check(
      'point_status_known',
      sql`${t.status} IN ('incomplete', 'complete', 'quarantined', 'expired')`,
    ),
  ],
);
export const manifests = pgTable(
  'manifests',
  {
    ...scoped(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    version: integer('version').notNull(),
    sha256: text('sha256').notNull(),
    body: jsonb('body').$type<RecoveryManifest>().notNull(),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.recoveryPointId),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    check('manifest_hash_valid', sql`${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.version} > 0`),
  ],
);
export const components = pgTable(
  'components',
  {
    ...scoped(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    componentKey: text('component_key').notNull(),
    artifactPath: text('artifact_path').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    required: boolean('required').notNull().default(true),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.recoveryPointId, t.componentKey),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    check('component_size_hash_valid', sql`${t.sizeBytes} >= 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const destinationResults = pgTable(
  'destination_results',
  {
    ...scoped(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    repositoryId: uuid('repository_id').notNull(),
    status: executionStatus('status').notNull().default('aguardando'),
    nativeSnapshotId: text('native_snapshot_id'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationScope: text('verification_scope'),
    postgresqlEvidence: jsonb('postgresql_evidence').$type<PostgresEvidence>(),
    dockerEvidence: jsonb('docker_evidence').$type<DockerEvidence>(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    retentionPending: boolean('retention_pending').notNull().default(false),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.recoveryPointId, t.repositoryId),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.repositoryId],
      foreignColumns: [repositories.organizationId, repositories.id],
    }),
    index('results_repository_verified_idx').on(t.organizationId, t.repositoryId, t.verifiedAt),
  ],
);
export const restoreTests = pgTable(
  'restore_tests',
  {
    ...scoped(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    repositoryId: uuid('repository_id').notNull(),
    scope: jsonb('scope').$type<RestoreScope>().notNull(),
    status: executionStatus('status').notNull().default('aguardando'),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.repositoryId],
      foreignColumns: [repositories.organizationId, repositories.id],
    }),
    index('restore_tests_point_date_idx').on(t.organizationId, t.recoveryPointId, t.testedAt),
  ],
);
export const restoreRequests = pgTable(
  'restore_requests',
  {
    ...scoped(),
    executionId: uuid('execution_id').notNull(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    scope: jsonb('scope').$type<RestoreScope>().notNull(),
    production: boolean('production').notNull().default(false),
    status: executionStatus('status').notNull().default('aguardando'),
  },
  (t) => [
    tenantKey(t),
    unique().on(t.organizationId, t.executionId),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    foreignKey({
      name: 'restore_requests_requester_membership_fk',
      columns: [t.organizationId, t.requestedBy],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('restore_requests_requester_idx').on(t.organizationId, t.requestedBy),
  ],
);
export const restoreConfirmations = pgTable(
  'restore_confirmations',
  {
    ...scoped(),
    requestId: uuid('request_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    systemName: text('system_name').notNull(),
    impact: text('impact').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.requestId],
      foreignColumns: [restoreRequests.organizationId, restoreRequests.id],
    }),
    foreignKey({
      name: 'restore_confirmations_actor_membership_fk',
      columns: [t.organizationId, t.actorId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('restore_confirmations_actor_idx').on(t.organizationId, t.actorId),
    check(
      'confirmation_name_impact_nonempty',
      sql`length(trim(${t.systemName})) > 0 AND length(trim(${t.impact})) > 0`,
    ),
  ],
);
export const operationalApprovals = pgTable(
  'operational_approvals',
  {
    ...scoped(),
    requestId: uuid('request_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    action: text('action').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.requestId],
      foreignColumns: [restoreRequests.organizationId, restoreRequests.id],
    }),
    foreignKey({
      name: 'operational_approvals_actor_membership_fk',
      columns: [t.organizationId, t.actorId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('operational_approvals_actor_idx').on(t.organizationId, t.actorId),
    check('approval_expires_after_grant', sql`${t.expiresAt} > ${t.approvedAt}`),
  ],
);
export const restoreResults = pgTable(
  'restore_results',
  {
    ...scoped(),
    requestId: uuid('request_id').notNull(),
    status: executionStatus('status').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.requestId],
      foreignColumns: [restoreRequests.organizationId, restoreRequests.id],
    }),
  ],
);
export const returnPoints = pgTable(
  'return_points',
  {
    ...scoped(),
    requestId: uuid('request_id').notNull(),
    recoveryPointId: uuid('recovery_point_id').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.requestId],
      foreignColumns: [restoreRequests.organizationId, restoreRequests.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.recoveryPointId],
      foreignColumns: [recoveryPoints.organizationId, recoveryPoints.id],
    }),
    check(
      'return_point_accept_before_release',
      sql`${t.releasedAt} IS NULL OR (${t.acceptedAt} IS NOT NULL AND ${t.releasedAt} >= ${t.acceptedAt})`,
    ),
  ],
);
export const auditEvents = pgTable(
  'audit_events',
  {
    ...scoped(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [tenantKey(t), index('audit_org_created_idx').on(t.organizationId, t.createdAt)],
);
export const catalogExports = pgTable(
  'catalog_exports',
  {
    ...scoped(),
    repositoryId: uuid('repository_id').notNull(),
    artifactReference: text('artifact_reference').notNull(),
    sha256: text('sha256').notNull(),
    encryptionKeyReference: text('encryption_key_reference').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.repositoryId],
      foreignColumns: [repositories.organizationId, repositories.id],
    }),
    check('catalog_export_hash_valid', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const recoveryKits = pgTable(
  'recovery_kits',
  {
    ...scoped(),
    catalogExportId: uuid('catalog_export_id'),
    version: integer('version').notNull(),
    artifactReference: text('artifact_reference').notNull(),
    keyCustodyReference: text('key_custody_reference').notNull(),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      columns: [t.organizationId, t.catalogExportId],
      foreignColumns: [catalogExports.organizationId, catalogExports.id],
    }),
    check('kit_version_positive', sql`${t.version} > 0`),
  ],
);

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Execution = typeof executions.$inferSelect;
export type RecoveryPoint = typeof recoveryPoints.$inferSelect;
export const postgresqlBindings = pgTable(
  'postgresql_bindings',
  {
    organizationId: uuid('organization_id').notNull(),
    profileVersionId: uuid('profile_version_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    databaseName: text('database_name').notNull(),
    schemaNames: text('schema_names')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.profileVersionId] }),
    unique().on(t.organizationId, t.connectionId, t.databaseName, t.schemaNames),
    foreignKey({
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
  ],
);
export type PostgresBinding = typeof postgresqlBindings.$inferSelect;
export const dockerCatalogs = pgTable(
  'docker_catalogs',
  {
    organizationId: uuid('organization_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    serverId: uuid('server_id').notNull(),
    body: jsonb('body').$type<DockerCatalog>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.agentId] }),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
    index('docker_catalog_server').on(t.organizationId, t.serverId, t.receivedAt),
  ],
);
export const dockerBindings = pgTable(
  'docker_bindings',
  {
    organizationId: uuid('organization_id').notNull(),
    profileVersionId: uuid('profile_version_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    serverId: uuid('server_id').notNull(),
    selection: jsonb('selection').$type<DockerSelection>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.profileVersionId] }),
    unique().on(t.organizationId, t.serverId, t.selection),
    foreignKey({
      columns: [t.organizationId, t.profileVersionId],
      foreignColumns: [profileVersions.organizationId, profileVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [resources.organizationId, resources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serverId],
      foreignColumns: [servers.organizationId, servers.id],
    }),
  ],
);
export type DockerBinding = typeof dockerBindings.$inferSelect;
export const dokployNativeRuns = pgTable(
  'dokploy_native_runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    selection: jsonb('selection').$type<Record<string, unknown>>().notNull(),
    providerContext: jsonb('provider_context').$type<Record<string, unknown>>().notNull(),
    baseline: jsonb('baseline').$type<unknown[]>().notNull(),
    status: text('status').notNull(),
    artifacts: jsonb('artifacts').$type<unknown[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => [
    unique().on(t.organizationId, t.idempotencyKey),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
  ],
);

export const repositoryTasks = pgTable(
  'repository_tasks',
  {
    organizationId: uuid('organization_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    scope: jsonb('scope').$type<AgentCommand['operation']>().notNull(),
    decisions: jsonb('decisions').$type<{ forget: string[]; protect: string[] }>(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.executionId] }),
    foreignKey({
      columns: [t.organizationId, t.executionId],
      foreignColumns: [executions.organizationId, executions.id],
    }),
  ],
);
