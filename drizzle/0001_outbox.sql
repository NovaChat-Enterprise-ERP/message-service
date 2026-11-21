CREATE TABLE "messaging"."outbox" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messaging"."outbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (6) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "messaging"."outbox" USING btree ("seq") WHERE "messaging"."outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_published_idx" ON "messaging"."outbox" USING btree ("published_at") WHERE "messaging"."outbox"."published_at" is not null;