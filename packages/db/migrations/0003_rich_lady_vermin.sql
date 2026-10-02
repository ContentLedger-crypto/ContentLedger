DROP INDEX "batches_consumer_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "batches_consumer_idx" ON "batches" USING btree ("consumer","seq_to");