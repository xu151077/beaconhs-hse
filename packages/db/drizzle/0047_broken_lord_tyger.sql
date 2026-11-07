CREATE TYPE "public"."storage_write_arm_operation" AS ENUM('presignPut', 'presignMultipartPart');--> statement-breakpoint
CREATE TYPE "public"."storage_write_arm_state" AS ENUM('issuing', 'armed', 'expired', 'reconciling', 'redeemed_confirmed', 'redeemed_nop', 'quarantined', 'failed_to_activate');--> statement-breakpoint
CREATE TABLE "in_flight_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"lease_id" uuid,
	"lease_version" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"success" boolean NOT NULL,
	"error" text,
	CONSTRAINT "in_flight_writes_tenant_key_ck" CHECK ("in_flight_writes"."key" LIKE ('t/' || "in_flight_writes"."tenant_id"::text || '/%')),
	CONSTRAINT "in_flight_writes_lease_version_ck" CHECK ("in_flight_writes"."lease_version" >= 0),
	CONSTRAINT "in_flight_writes_status_ck" CHECK ((
        ("in_flight_writes"."completed_at" IS NULL AND "in_flight_writes"."success" = false)
        OR
        ("in_flight_writes"."completed_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "storage_write_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation" "storage_write_arm_operation" NOT NULL,
	"object_key" text NOT NULL,
	"upload_token" text NOT NULL,
	"upload_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" "storage_write_arm_state" DEFAULT 'issuing' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"quarantined_reason" text,
	"reconciled_at" timestamp with time zone,
	"issued_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_write_arms_tenant_key_ck" CHECK ("storage_write_arms"."object_key" like ('t/' || "storage_write_arms"."tenant_id"::text || '/%'))
);
--> statement-breakpoint
ALTER TABLE "in_flight_writes" ADD CONSTRAINT "in_flight_writes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_write_arms" ADD CONSTRAINT "storage_write_arms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "in_flight_writes_tenant_id_idx" ON "in_flight_writes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "in_flight_writes_tenant_key_idx" ON "in_flight_writes" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "in_flight_writes_lease_id_idx" ON "in_flight_writes" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "in_flight_writes_tenant_completed_idx" ON "in_flight_writes" USING btree ("tenant_id",completed_at NULLS FIRST);--> statement-breakpoint
CREATE INDEX "storage_write_arms_tenant_id_idx" ON "storage_write_arms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storage_write_arms_state_expires_idx" ON "storage_write_arms" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "storage_write_arms_tenant_state_idx" ON "storage_write_arms" USING btree ("tenant_id","state");