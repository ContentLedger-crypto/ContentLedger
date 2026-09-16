CREATE TYPE "public"."licence_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('escrow', 'x402');--> statement-breakpoint
CREATE TYPE "public"."rate_level" AS ENUM('domain', 'work');--> statement-breakpoint
CREATE TYPE "public"."use_type" AS ENUM('train', 'inference');--> statement-breakpoint
CREATE TABLE "attestations" (
	"work_id" text NOT NULL,
	"node_key" text NOT NULL,
	"content_hash" char(64) NOT NULL,
	"owner_claimed" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "attestations_work_id_node_key_pk" PRIMARY KEY("work_id","node_key")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" char(64) PRIMARY KEY NOT NULL,
	"consumer" text NOT NULL,
	"seq_from" bigint NOT NULL,
	"seq_to" bigint NOT NULL,
	"root" char(64) NOT NULL,
	"chain" char(64) NOT NULL,
	"tx_sig" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "batches_range_ordered" CHECK ("batches"."seq_to" >= "batches"."seq_from"),
	CONSTRAINT "batches_seq_from_positive" CHECK ("batches"."seq_from" >= 1)
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"host" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"payout_owner" text NOT NULL,
	"rate_train" bigint NOT NULL,
	"rate_inference" bigint NOT NULL,
	"status" "licence_status" NOT NULL,
	"slot" bigint NOT NULL,
	CONSTRAINT "domains_rate_train_non_negative" CHECK ("domains"."rate_train" >= 0),
	CONSTRAINT "domains_rate_inference_non_negative" CHECK ("domains"."rate_inference" >= 0)
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"consumer" text PRIMARY KEY NOT NULL,
	"deposited" bigint NOT NULL,
	"settled_total" bigint NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_chain" char(64) NOT NULL,
	"slot" bigint NOT NULL,
	CONSTRAINT "escrows_deposited_non_negative" CHECK ("escrows"."deposited" >= 0),
	CONSTRAINT "escrows_settled_total_non_negative" CHECK ("escrows"."settled_total" >= 0),
	CONSTRAINT "escrows_last_seq_non_negative" CHECK ("escrows"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" char(64) PRIMARY KEY NOT NULL,
	"consumer" text NOT NULL,
	"work_id" text NOT NULL,
	"use_type" "use_type" NOT NULL,
	"tariff" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"node_cut" bigint,
	"rate_level" "rate_level" NOT NULL,
	"served_hash" char(64) NOT NULL,
	"registry_hash" char(64) NOT NULL,
	"hash_match" boolean NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_ref" text,
	"accepted_at" text NOT NULL,
	"accepted_ts" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"batch_id" char(64),
	CONSTRAINT "receipts_tariff_non_negative" CHECK ("receipts"."tariff" >= 0),
	CONSTRAINT "receipts_fee_non_negative" CHECK ("receipts"."fee" >= 0),
	CONSTRAINT "receipts_node_cut_non_negative" CHECK ("receipts"."node_cut" >= 0),
	CONSTRAINT "receipts_payment_ref_matches_method" CHECK (("receipts"."payment_method" = 'x402') = ("receipts"."payment_ref" is not null)),
	CONSTRAINT "receipts_x402_never_batched" CHECK ("receipts"."payment_method" = 'escrow' or "receipts"."batch_id" is null)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" char(64) PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"consumer" text NOT NULL,
	"seq" bigint NOT NULL,
	"cumulative" bigint NOT NULL,
	"chain" char(64) NOT NULL,
	"signature" text NOT NULL,
	"receipt_id" char(64) NOT NULL,
	"batch_id" char(64),
	CONSTRAINT "vouchers_consumer_seq_pk" PRIMARY KEY("consumer","seq"),
	CONSTRAINT "vouchers_seq_positive" CHECK ("vouchers"."seq" >= 1),
	CONSTRAINT "vouchers_cumulative_non_negative" CHECK ("vouchers"."cumulative" >= 0)
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" char(64) NOT NULL,
	"rate_train" bigint,
	"rate_inference" bigint,
	"status" "licence_status" NOT NULL,
	"media_type" text NOT NULL,
	"byte_len" integer NOT NULL,
	"slot" bigint NOT NULL,
	CONSTRAINT "works_rate_train_non_negative" CHECK ("works"."rate_train" >= 0),
	CONSTRAINT "works_rate_inference_non_negative" CHECK ("works"."rate_inference" >= 0),
	CONSTRAINT "works_byte_len_non_negative" CHECK ("works"."byte_len" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_host_domains_host_fk" FOREIGN KEY ("host") REFERENCES "public"."domains"("host") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_consumer_idx" ON "batches" USING btree ("consumer","seq_to");--> statement-breakpoint
CREATE INDEX "domains_owner_idx" ON "domains" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "receipts_consumer_idx" ON "receipts" USING btree ("consumer","accepted_ts");--> statement-breakpoint
CREATE INDEX "receipts_work_idx" ON "receipts" USING btree ("work_id","accepted_ts");--> statement-breakpoint
CREATE INDEX "receipts_batch_idx" ON "receipts" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_receipt_idx" ON "vouchers" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "vouchers_batch_idx" ON "vouchers" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "works_source_id_idx" ON "works" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "works_host_idx" ON "works" USING btree ("host");