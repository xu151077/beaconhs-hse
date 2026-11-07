-- Repair 0049: the original migration file was written with literal "\\n"
-- escapes, so the entire statement was treated as a comment. Fresh databases
-- marked 0049 applied without creating the column. This additive repair is
-- idempotent for both fresh and already-marked databases.
ALTER TABLE "attachment_upload_reservations"
  ADD COLUMN IF NOT EXISTS "multipart_upload_id" text;
