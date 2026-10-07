CREATE TABLE "settler_heartbeat" (
	"id" integer PRIMARY KEY NOT NULL,
	"passed_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer NOT NULL,
	"failed_agents" integer NOT NULL,
	CONSTRAINT "settler_heartbeat_single_row" CHECK ("settler_heartbeat"."id" = 1),
	CONSTRAINT "settler_heartbeat_interval_positive" CHECK ("settler_heartbeat"."interval_seconds" > 0),
	CONSTRAINT "settler_heartbeat_failed_non_negative" CHECK ("settler_heartbeat"."failed_agents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "settler_heartbeat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "settler_heartbeat_deny_all" ON "settler_heartbeat" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);