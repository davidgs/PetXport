ALTER TABLE "users" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_consent_at" timestamp with time zone;--> statement-breakpoint
-- People who had already switched text messages on did so themselves, on their own profile.
UPDATE "users" SET "sms_consent_at" = now() WHERE "id" IN (SELECT "user_id" FROM "driver_profiles" WHERE "notify_sms");
