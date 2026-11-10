ALTER TABLE "api_keys" ADD COLUMN "principal_tenant_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
CREATE INDEX "api_keys_principal_idx" ON "api_keys" USING btree ("tenant_id","principal_tenant_user_id");