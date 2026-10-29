-- APBackup catalog. No seed, remote operations, schedules or credentials are created.
CREATE TYPE "public"."destination_kind" AS ENUM('sftp', 'smb', 'google_drive', 's3', 'pbs');--> statement-breakpoint
CREATE TYPE "public"."destination_status" AS ENUM('aguardando_configuracao', 'ativo', 'indisponivel', 'desabilitado');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('aguardando', 'verificando', 'capturando', 'enviando', 'verificando_destino', 'concluida', 'falhas_parciais', 'falhou', 'cancelada', 'exige_intervencao');--> statement-breakpoint
CREATE TYPE "public"."operation_kind" AS ENUM('backup', 'restore', 'verify', 'retention', 'catalog_export', 'recovery_drill');--> statement-breakpoint
CREATE TYPE "public"."resource_kind" AS ENUM('postgresql', 'files', 'compose', 'swarm', 'dokploy', 'redis', 'supabase_schema', 'supabase_auth', 'supabase_storage', 'vm', 'proxmox_host', 'pbs_configuration');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('administrator', 'backup_operator', 'restore_operator', 'viewer');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"external_identity" text NOT NULL,
	"public_key" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agents_organization_id_external_identity_unique" UNIQUE("organization_id","external_identity")
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	"agent_journal_reference" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "attempts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "attempts_organization_id_step_id_number_unique" UNIQUE("organization_id","step_id","number"),
	CONSTRAINT "attempt_number_positive" CHECK ("attempts"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "catalog_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"artifact_reference" text NOT NULL,
	"sha256" text NOT NULL,
	"encryption_key_reference" text NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "catalog_exports_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "catalog_export_hash_valid" CHECK ("catalog_exports"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"component_key" text NOT NULL,
	"artifact_path" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "components_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "components_organization_id_recovery_point_id_component_key_unique" UNIQUE("organization_id","recovery_point_id","component_key"),
	CONSTRAINT "component_size_hash_valid" CHECK ("components"."size_bytes" >= 0 AND "components"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"secret_reference_id" uuid,
	CONSTRAINT "connections_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "connector_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"connector_name" text NOT NULL,
	"connector_version" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connector_capabilities_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "connector_capabilities_organization_id_destination_id_connector_version_unique" UNIQUE("organization_id","destination_id","connector_version")
);
--> statement-breakpoint
CREATE TABLE "destination_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	"native_snapshot_id" text,
	"size_bytes" bigint,
	"verified_at" timestamp with time zone,
	"verification_scope" text,
	CONSTRAINT "destination_results_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "destination_results_organization_id_recovery_point_id_repository_id_unique" UNIQUE("organization_id","recovery_point_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "destination_kind" NOT NULL,
	"host" text,
	"status" "destination_status" DEFAULT 'aguardando_configuracao' NOT NULL,
	"root_path" text,
	"credential_id" uuid,
	CONSTRAINT "destinations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "active_destination_configured" CHECK ("destinations"."status" <> 'ativo' OR (nullif(trim("destinations"."root_path"), '') IS NOT NULL AND "destinations"."credential_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_id" uuid,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "execution_events_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "execution_steps_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "execution_steps_organization_id_execution_id_key_unique" UNIQUE("organization_id","execution_id","key"),
	CONSTRAINT "execution_steps_organization_id_execution_id_position_unique" UNIQUE("organization_id","execution_id","position"),
	CONSTRAINT "step_position_nonnegative" CHECK ("execution_steps"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid,
	"agent_id" uuid,
	"kind" "operation_kind" NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	"idempotency_key" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "executions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "executions_organization_id_idempotency_key_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "executions_organization_id_plan_id_scheduled_for_unique" UNIQUE("organization_id","plan_id","scheduled_for")
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"holder" uuid NOT NULL,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "leases_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "leases_organization_id_resource_id_unique" UNIQUE("organization_id","resource_id"),
	CONSTRAINT "lease_fencing_positive" CHECK ("leases"."fencing_token" > 0)
);
--> statement-breakpoint
CREATE TABLE "manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "manifests_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "manifests_organization_id_recovery_point_id_unique" UNIQUE("organization_id","recovery_point_id"),
	CONSTRAINT "manifest_hash_valid" CHECK ("manifests"."sha256" ~ '^[a-f0-9]{64}$' AND "manifests"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "operational_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operational_approvals_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "approval_expires_after_grant" CHECK ("operational_approvals"."expires_at" > "operational_approvals"."approved_at")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "organization_name_nonempty" CHECK (length(trim("organizations"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "plan_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plan_destinations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "plan_destinations_organization_id_plan_id_repository_id_unique" UNIQUE("organization_id","plan_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "plan_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	CONSTRAINT "plan_resources_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "plan_resources_organization_id_plan_id_resource_id_unique" UNIQUE("organization_id","plan_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"profile_version_id" uuid,
	"retention_policy_id" uuid,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "plans_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "profile_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "profile_resources_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "profile_resources_organization_id_profile_version_id_resource_id_unique" UNIQUE("organization_id","profile_version_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "profile_versions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "profile_versions_organization_id_profile_id_version_unique" UNIQUE("organization_id","profile_id","version"),
	CONSTRAINT "profile_version_positive" CHECK ("profile_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"catalog_export_id" uuid,
	"version" integer NOT NULL,
	"artifact_reference" text NOT NULL,
	"key_custody_reference" text NOT NULL,
	"tested_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "recovery_kits_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "kit_version_positive" CHECK ("recovery_kits"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"profile_version_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"protected_until" timestamp with time zone,
	CONSTRAINT "recovery_points_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "point_status_known" CHECK ("recovery_points"."status" IN ('incomplete', 'complete', 'quarantined', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"external_identity" text NOT NULL,
	"engine" text NOT NULL,
	"capture_credential_id" uuid,
	"maintenance_credential_id" uuid,
	CONSTRAINT "repositories_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "repositories_organization_id_destination_id_external_identity_unique" UNIQUE("organization_id","destination_id","external_identity")
);
--> statement-breakpoint
CREATE TABLE "resource_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"depends_on_resource_id" uuid NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	CONSTRAINT "resource_dependencies_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "resource_dependencies_organization_id_resource_id_depends_on_resource_id_unique" UNIQUE("organization_id","resource_id","depends_on_resource_id"),
	CONSTRAINT "resource_not_self_dependent" CHECK ("resource_dependencies"."resource_id" <> "resource_dependencies"."depends_on_resource_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" "resource_kind" NOT NULL,
	"name" text NOT NULL,
	"external_identity" text NOT NULL,
	CONSTRAINT "resources_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "resources_organization_id_server_id_kind_external_identity_unique" UNIQUE("organization_id","server_id","kind","external_identity")
);
--> statement-breakpoint
CREATE TABLE "restore_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"system_name" text NOT NULL,
	"impact" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"reauthenticated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "restore_confirmations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "confirmation_name_impact_nonempty" CHECK (length(trim("restore_confirmations"."system_name")) > 0 AND length(trim("restore_confirmations"."impact")) > 0)
);
--> statement-breakpoint
CREATE TABLE "restore_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"production" boolean DEFAULT false NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	CONSTRAINT "restore_requests_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "restore_requests_organization_id_execution_id_unique" UNIQUE("organization_id","execution_id")
);
--> statement-breakpoint
CREATE TABLE "restore_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" "execution_status" NOT NULL,
	"completed_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "restore_results_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "restore_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"status" "execution_status" DEFAULT 'aguardando' NOT NULL,
	"tested_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "restore_tests_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days" integer DEFAULT 7 NOT NULL,
	"evidence_days" integer DEFAULT 90 NOT NULL,
	"protect_last_verified" boolean DEFAULT true NOT NULL,
	CONSTRAINT "retention_policies_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "retention_positive_days" CHECK ("retention_policies"."days" > 0 AND "retention_policies"."evidence_days" > 0),
	CONSTRAINT "retention_protect_last_verified" CHECK ("retention_policies"."protect_last_verified" = true)
);
--> statement-breakpoint
CREATE TABLE "return_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"recovery_point_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "return_points_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "return_point_accept_before_release" CHECK ("return_points"."released_at" IS NULL OR ("return_points"."accepted_at" IS NOT NULL AND "return_points"."released_at" >= "return_points"."accepted_at"))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"local_time" time DEFAULT '03:00:00' NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	CONSTRAINT "schedules_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "schedules_organization_id_plan_id_local_time_timezone_unique" UNIQUE("organization_id","plan_id","local_time","timezone"),
	CONSTRAINT "schedule_time_in_day" CHECK ("schedules"."local_time" < '24:00:00'::time)
);
--> statement-breakpoint
CREATE TABLE "secret_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_reference" text NOT NULL,
	"algorithm" text DEFAULT 'aes-256-gcm' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "secret_references_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "secret_references_organization_id_name_version_unique" UNIQUE("organization_id","name","version"),
	CONSTRAINT "secret_reference_envelope" CHECK (length("secret_references"."ciphertext") > 0 AND length("secret_references"."key_reference") > 0 AND "secret_references"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_identity" text NOT NULL,
	"hostname" text,
	CONSTRAINT "servers_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "servers_organization_id_external_identity_unique" UNIQUE("organization_id","external_identity"),
	CONSTRAINT "server_identity_nonempty" CHECK (length(trim("servers"."external_identity")) > 0)
);
--> statement-breakpoint
CREATE TABLE "system_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_identity" text NOT NULL,
	CONSTRAINT "system_profiles_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "system_profiles_organization_id_server_id_external_identity_unique" UNIQUE("organization_id","server_id","external_identity")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "public"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_exports" ADD CONSTRAINT "catalog_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_exports" ADD CONSTRAINT "catalog_exports_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_organization_id_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_secret_reference_id_secret_references_organization_id_id_fk" FOREIGN KEY ("organization_id","secret_reference_id") REFERENCES "public"."secret_references"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_capabilities" ADD CONSTRAINT "connector_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_capabilities" ADD CONSTRAINT "connector_capabilities_organization_id_destination_id_destinations_organization_id_id_fk" FOREIGN KEY ("organization_id","destination_id") REFERENCES "public"."destinations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_results" ADD CONSTRAINT "destination_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_results" ADD CONSTRAINT "destination_results_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_results" ADD CONSTRAINT "destination_results_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_organization_id_credential_id_secret_references_organization_id_id_fk" FOREIGN KEY ("organization_id","credential_id") REFERENCES "public"."secret_references"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_organization_id_execution_id_executions_organization_id_id_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_organization_id_step_id_execution_steps_organization_id_id_fk" FOREIGN KEY ("organization_id","step_id") REFERENCES "public"."execution_steps"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_organization_id_execution_id_executions_organization_id_id_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_organization_id_plan_id_plans_organization_id_id_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_execution_id_executions_organization_id_id_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_approvals" ADD CONSTRAINT "operational_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_approvals" ADD CONSTRAINT "operational_approvals_organization_id_request_id_restore_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."restore_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_destinations" ADD CONSTRAINT "plan_destinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_destinations" ADD CONSTRAINT "plan_destinations_organization_id_plan_id_plans_organization_id_id_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_destinations" ADD CONSTRAINT "plan_destinations_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_resources" ADD CONSTRAINT "plan_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_resources" ADD CONSTRAINT "plan_resources_organization_id_plan_id_plans_organization_id_id_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_resources" ADD CONSTRAINT "plan_resources_organization_id_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_profile_version_id_profile_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_version_id") REFERENCES "public"."profile_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_retention_policy_id_retention_policies_organization_id_id_fk" FOREIGN KEY ("organization_id","retention_policy_id") REFERENCES "public"."retention_policies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_resources" ADD CONSTRAINT "profile_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_resources" ADD CONSTRAINT "profile_resources_organization_id_profile_version_id_profile_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_version_id") REFERENCES "public"."profile_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_resources" ADD CONSTRAINT "profile_resources_organization_id_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_organization_id_profile_id_system_profiles_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "public"."system_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_kits" ADD CONSTRAINT "recovery_kits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_kits" ADD CONSTRAINT "recovery_kits_organization_id_catalog_export_id_catalog_exports_organization_id_id_fk" FOREIGN KEY ("organization_id","catalog_export_id") REFERENCES "public"."catalog_exports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_points" ADD CONSTRAINT "recovery_points_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_points" ADD CONSTRAINT "recovery_points_organization_id_execution_id_executions_organization_id_id_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_points" ADD CONSTRAINT "recovery_points_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_points" ADD CONSTRAINT "recovery_points_organization_id_profile_version_id_profile_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","profile_version_id") REFERENCES "public"."profile_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_destination_id_destinations_organization_id_id_fk" FOREIGN KEY ("organization_id","destination_id") REFERENCES "public"."destinations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_capture_credential_id_secret_references_organization_id_id_fk" FOREIGN KEY ("organization_id","capture_credential_id") REFERENCES "public"."secret_references"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_maintenance_credential_id_secret_references_organization_id_id_fk" FOREIGN KEY ("organization_id","maintenance_credential_id") REFERENCES "public"."secret_references"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_dependencies" ADD CONSTRAINT "resource_dependencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_dependencies" ADD CONSTRAINT "resource_dependencies_organization_id_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_dependencies" ADD CONSTRAINT "resource_dependencies_organization_id_depends_on_resource_id_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","depends_on_resource_id") REFERENCES "public"."resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_confirmations" ADD CONSTRAINT "restore_confirmations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_confirmations" ADD CONSTRAINT "restore_confirmations_organization_id_request_id_restore_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."restore_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_organization_id_execution_id_executions_organization_id_id_fk" FOREIGN KEY ("organization_id","execution_id") REFERENCES "public"."executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_results" ADD CONSTRAINT "restore_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_results" ADD CONSTRAINT "restore_results_organization_id_request_id_restore_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."restore_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_tests" ADD CONSTRAINT "restore_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_tests" ADD CONSTRAINT "restore_tests_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_tests" ADD CONSTRAINT "restore_tests_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_points" ADD CONSTRAINT "return_points_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_points" ADD CONSTRAINT "return_points_organization_id_request_id_restore_requests_organization_id_id_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."restore_requests"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_points" ADD CONSTRAINT "return_points_organization_id_recovery_point_id_recovery_points_organization_id_id_fk" FOREIGN KEY ("organization_id","recovery_point_id") REFERENCES "public"."recovery_points"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organization_id_plan_id_plans_organization_id_id_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."plans"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_references" ADD CONSTRAINT "secret_references_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_profiles" ADD CONSTRAINT "system_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_profiles" ADD CONSTRAINT "system_profiles_organization_id_server_id_servers_organization_id_id_fk" FOREIGN KEY ("organization_id","server_id") REFERENCES "public"."servers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_server_idx" ON "agents" USING btree ("organization_id","server_id");--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "connections_server_idx" ON "connections" USING btree ("organization_id","server_id");--> statement-breakpoint
CREATE INDEX "results_repository_verified_idx" ON "destination_results" USING btree ("organization_id","repository_id","verified_at");--> statement-breakpoint
CREATE INDEX "events_execution_created_idx" ON "execution_events" USING btree ("organization_id","execution_id","created_at");--> statement-breakpoint
CREATE INDEX "executions_org_status_created_idx" ON "executions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "executions_plan_created_idx" ON "executions" USING btree ("organization_id","plan_id","created_at");--> statement-breakpoint
CREATE INDEX "leases_expiry_idx" ON "leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "plans_server_idx" ON "plans" USING btree ("organization_id","server_id");--> statement-breakpoint
CREATE INDEX "points_profile_capture_idx" ON "recovery_points" USING btree ("organization_id","profile_version_id","captured_at");--> statement-breakpoint
CREATE INDEX "resources_server_idx" ON "resources" USING btree ("organization_id","server_id");--> statement-breakpoint
CREATE INDEX "restore_tests_point_date_idx" ON "restore_tests" USING btree ("organization_id","recovery_point_id","tested_at");--> statement-breakpoint
CREATE INDEX "schedules_enabled_idx" ON "schedules" USING btree ("enabled","local_time");--> statement-breakpoint
CREATE INDEX "servers_org_name_idx" ON "servers" USING btree ("organization_id","name");
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "platform_role" DEFAULT 'viewer' NOT NULL,
	CONSTRAINT "organization_memberships_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "organization_memberships_organization_id_user_id_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "user_email_normalized" CHECK ("users"."email" = lower(trim("users"."email")) AND position('@' in "users"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "organization_memberships" USING btree ("user_id");

-- UTC instants in timestamptz; schedules carry their explicit IANA timezone.
CREATE FUNCTION platform_valid_timezone(value text) RETURNS boolean
LANGUAGE sql STABLE STRICT AS $$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = value) $$;
ALTER TABLE schedules ADD CONSTRAINT schedule_timezone_valid CHECK (platform_valid_timezone(timezone));

CREATE FUNCTION platform_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
      AND table_name = ANY(ARRAY['organizations', 'users', 'organization_memberships', 'secret_references', 'servers', 'agents', 'connections', 'resources', 'resource_dependencies', 'system_profiles', 'profile_versions', 'profile_resources', 'destinations', 'connector_capabilities', 'repositories', 'retention_policies', 'plans', 'plan_resources', 'plan_destinations', 'schedules', 'executions', 'execution_steps', 'attempts', 'leases', 'execution_events', 'recovery_points', 'manifests', 'components', 'destination_results', 'restore_tests', 'restore_requests', 'restore_confirmations', 'operational_approvals', 'restore_results', 'return_points', 'audit_events', 'catalog_exports', 'recovery_kits'])
  LOOP
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at()', target.table_name);
  END LOOP;
END $$;

-- Defense in depth for evidence/manifest JSON. DTO validation and log redaction are
-- still required; no pattern detector can identify every arbitrary secret string.
CREATE FUNCTION platform_public_json_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item record;
DECLARE scalar text;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    FOR item IN SELECT key, val FROM jsonb_each(value) AS e(key, val) LOOP
      IF item.key ~* '^(password|passwd|token|access_token|refresh_token|secret|api_key|authorization|private_key|service_role_key|credential|credentials|dsn|connection_string)$'
         OR NOT platform_public_json_valid(item.val) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT val FROM jsonb_array_elements(value) AS e(val) LOOP
      IF NOT platform_public_json_valid(item.val) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'string' THEN
    scalar := value #>> '{}';
    IF scalar ~* '([a-z][a-z0-9+.-]*://[^/@[:space:]]+:[^/@[:space:]]+@|Bearer[[:space:]]+|-----BEGIN|[?&](token|password|secret|api_key)=)' THEN RETURN false; END IF;
  END IF;
  RETURN true;
END $$;
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'jsonb'
      AND table_name = ANY(ARRAY['profile_versions', 'connector_capabilities', 'execution_events', 'manifests', 'restore_tests', 'restore_requests', 'restore_results', 'audit_events', 'recovery_kits'])
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (platform_public_json_valid(%I))',
      target.table_name, target.table_name || '_' || target.column_name || '_public', target.column_name);
  END LOOP;
END $$;
COMMENT ON TABLE secret_references IS 'Server-only encrypted envelopes. Master keys are held outside the catalog.';
COMMENT ON TABLE schedules IS 'Inactive by default. No installation or migration activates external backup jobs.';
COMMENT ON TABLE destination_results IS 'Evidence is specific to one recovery point and repository; completion does not imply a restore drill.';
