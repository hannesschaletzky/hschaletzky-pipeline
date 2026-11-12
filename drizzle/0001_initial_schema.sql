CREATE TYPE "public"."application_event_type" AS ENUM('status_change', 'note', 'contact');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('interesting', 'applied', 'presented', 'interview', 'offer', 'won', 'rejected', 'withdrawn', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."organization_kind" AS ENUM('agency', 'portal', 'end_client');--> statement-breakpoint
CREATE TYPE "public"."rate_unit" AS ENUM('hour', 'day');--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "application_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"application_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "application_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "application_events_payload_type_matches" CHECK ("application_events"."payload"->>'type' = "application_events"."type"::text)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "applications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"title" text NOT NULL,
	"status" "application_status" DEFAULT 'interesting' NOT NULL,
	"agency_id" integer,
	"contact_id" integer,
	"agency_project_id" text,
	"end_client_id" integer,
	"same_project_as_id" integer,
	"end_client_hints" text,
	"location" text,
	"remote_share" smallint,
	"start_date" date,
	"end_date" date,
	"duration_text" text,
	"stack" text[] DEFAULT '{}'::text[] NOT NULL,
	"posting_text" text,
	"cover_letter" text,
	"cv_variant" text,
	"rate_eur" integer,
	"rate_unit" "rate_unit" DEFAULT 'hour' NOT NULL,
	"notes" text,
	CONSTRAINT "applications_closed_at_matches_status" CHECK (("applications"."status" in ('won', 'rejected', 'withdrawn', 'skipped')) = ("applications"."closed_at" is not null)),
	CONSTRAINT "applications_remote_share_range" CHECK ("applications"."remote_share" is null or "applications"."remote_share" between 0 and 100),
	CONSTRAINT "applications_not_same_project_as_itself" CHECK ("applications"."same_project_as_id" <> "applications"."id"),
	CONSTRAINT "applications_rate_eur_positive" CHECK ("applications"."rate_eur" is null or "applications"."rate_eur" > 0),
	CONSTRAINT "applications_date_order" CHECK ("applications"."start_date" is null or "applications"."end_date" is null or "applications"."end_date" >= "applications"."start_date")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organization_id" integer,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" date
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"kind" "organization_kind",
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_normalized_name_key" UNIQUE("normalized_name")
);
--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_agency_id_organizations_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_end_client_id_organizations_id_fk" FOREIGN KEY ("end_client_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_same_project_as_id_applications_id_fk" FOREIGN KEY ("same_project_as_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_application_id_created_at_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_agency_id_idx" ON "applications" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "applications_end_client_id_idx" ON "applications" USING btree ("end_client_id");--> statement-breakpoint
CREATE INDEX "applications_contact_id_idx" ON "applications" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "applications_same_project_as_id_idx" ON "applications" USING btree ("same_project_as_id");--> statement-breakpoint
CREATE INDEX "applications_stack_idx" ON "applications" USING gin ("stack");--> statement-breakpoint
CREATE INDEX "applications_posting_text_trgm_idx" ON "applications" USING gin ("posting_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_organization_id_idx" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_delete_after_idx" ON "contacts" USING btree ("delete_after");