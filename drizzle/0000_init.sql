CREATE SCHEMA "messaging";
--> statement-breakpoint
CREATE TABLE "messaging"."conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_read_at" timestamp (6) with time zone,
	"muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messaging"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"topic" text,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"dm_key" text,
	"created_by" text NOT NULL,
	"archived_at" timestamp (6) with time zone,
	"last_message_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"parent_id" uuid,
	"kind" text DEFAULT 'user' NOT NULL,
	"body" jsonb,
	"text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", ''))) STORED,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentions_channel" boolean DEFAULT false NOT NULL,
	"client_msg_id" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp (6) with time zone,
	"reply_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_at" timestamp (6) with time zone,
	"deleted_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging"."pins" (
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by" text NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pins_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "messaging"."reactions" (
	"message_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "messaging"."thread_participants" (
	"root_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_read_at" timestamp (6) with time zone,
	CONSTRAINT "thread_participants_root_id_user_id_pk" PRIMARY KEY("root_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "messaging"."conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "messaging"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "messaging"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging"."pins" ADD CONSTRAINT "pins_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "messaging"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging"."pins" ADD CONSTRAINT "pins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messaging"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging"."reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messaging"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging"."thread_participants" ADD CONSTRAINT "thread_participants_root_id_messages_id_fk" FOREIGN KEY ("root_id") REFERENCES "messaging"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_members_user_idx" ON "messaging"."conversation_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "conversations_workspace_idx" ON "messaging"."conversations" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_workspace_name_uq" ON "messaging"."conversations" USING btree ("workspace_id","name") WHERE "messaging"."conversations"."name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_workspace_dm_key_uq" ON "messaging"."conversations" USING btree ("workspace_id","dm_key") WHERE "messaging"."conversations"."dm_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messaging"."messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_parent_created_idx" ON "messaging"."messages" USING btree ("parent_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messaging"."messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "messages_mentions_idx" ON "messaging"."messages" USING gin ("mentions");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_author_client_msg_uq" ON "messaging"."messages" USING btree ("author_id","client_msg_id") WHERE "messaging"."messages"."client_msg_id" is not null;--> statement-breakpoint
CREATE INDEX "thread_participants_user_idx" ON "messaging"."thread_participants" USING btree ("workspace_id","user_id");