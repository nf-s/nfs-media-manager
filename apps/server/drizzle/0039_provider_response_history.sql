-- A response-only cutover can install this exact archive before Mixes.
-- The normal migrator must still record both migrations in journal order.
DO $migration$
DECLARE
    archive regclass := to_regclass('public.provider_response');
    signature text[];
    original_search_path text := current_setting('search_path');
BEGIN
    IF archive IS NOT NULL THEN
        LOCK TABLE public.provider_response IN ACCESS SHARE MODE;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class
            WHERE oid = archive
                AND relkind = 'r' AND relpersistence = 'p'
                AND pg_has_role(relowner, 'USAGE')
                AND NOT relrowsecurity AND NOT relforcerowsecurity
        ) OR EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgrelid = archive AND (NOT tgisinternal OR tgenabled <> 'O')
        ) OR EXISTS (
            SELECT 1 FROM pg_rewrite WHERE ev_class = archive
        ) OR EXISTS (
            SELECT 1 FROM pg_inherits WHERE inhrelid = archive OR inhparent = archive
        ) THEN
            RAISE EXCEPTION 'Unexpected existing provider_response table';
        END IF;

        SELECT ARRAY(
            SELECT concat_ws(' ', attname, format_type(atttypid, atttypmod),
                CASE WHEN attnotnull THEN 'NOT NULL' END,
                pg_get_expr(adbin, adrelid))
            FROM pg_attribute
            JOIN pg_type ON pg_type.oid = atttypid
            LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
            WHERE attrelid = archive AND attnum > 0 AND NOT attisdropped
                AND attidentity = '' AND attgenerated = '' AND attndims = 0
                AND attcollation = typcollation
            ORDER BY attnum
        ) INTO signature;

        IF signature IS DISTINCT FROM ARRAY[
            'id text NOT NULL', 'job_id text NOT NULL', 'job_item_id text', 'artist_id text',
            'provider text NOT NULL', 'attempt integer NOT NULL', 'ordinal integer NOT NULL',
            'phase text NOT NULL', 'method text NOT NULL', 'request_url text', 'request_key text',
            'status integer', 'received_at timestamp without time zone', 'content_type text',
            'retry integer', 'not_found boolean NOT NULL false', 'body_state text NOT NULL',
            'retained_bytes integer NOT NULL', 'body jsonb NOT NULL'
        ] THEN
            RAISE EXCEPTION 'Unexpected existing provider_response columns';
        END IF;

        -- Qualify external FK relations regardless of the session search path.
        PERFORM set_config('search_path', 'pg_catalog', true);
        SELECT ARRAY(
            SELECT conname || ': ' || pg_get_constraintdef(oid)
            FROM pg_constraint
            WHERE conrelid = archive AND contype <> 'n'
            ORDER BY conname::text COLLATE "C"
        ) INTO signature;

        IF signature IS DISTINCT FROM ARRAY[
            'provider_response_artist_id_artist_id_fk: FOREIGN KEY (artist_id) REFERENCES public.artist(id) ON DELETE SET NULL',
            'provider_response_body_state_check: CHECK ((body_state = (body ->> ''state''::text)))',
            'provider_response_job_id_scrape_job_id_fk: FOREIGN KEY (job_id) REFERENCES public.scrape_job(id) ON DELETE CASCADE',
            'provider_response_job_item_id_scrape_job_item_id_fk: FOREIGN KEY (job_item_id) REFERENCES public.scrape_job_item(id) ON DELETE CASCADE',
            'provider_response_pkey: PRIMARY KEY (id)',
            'provider_response_sequence_check: CHECK (((attempt > 0) AND (ordinal > 0)))',
            'provider_response_size_check: CHECK (((retained_bytes >= 0) AND (retained_bytes <= 16777216)))'
        ] THEN
            RAISE EXCEPTION 'Unexpected existing provider_response constraints';
        END IF;

        SELECT ARRAY(
            SELECT pg_get_indexdef(indexrelid)
            FROM pg_index
            JOIN pg_class ON oid = indexrelid
            WHERE indrelid = archive AND indisvalid AND indisready AND indislive
            ORDER BY relname::text COLLATE "C"
        ) INTO signature;

        IF signature IS DISTINCT FROM ARRAY[
            'CREATE UNIQUE INDEX provider_response_item_attempt_uidx ON public.provider_response USING btree (job_id, job_item_id, attempt, ordinal) WHERE (job_item_id IS NOT NULL)',
            'CREATE INDEX provider_response_job_order_idx ON public.provider_response USING btree (job_id, attempt, ordinal, id)',
            'CREATE UNIQUE INDEX provider_response_pkey ON public.provider_response USING btree (id)',
            'CREATE UNIQUE INDEX provider_response_task_attempt_uidx ON public.provider_response USING btree (job_id, attempt, ordinal) WHERE (job_item_id IS NULL)'
        ] OR EXISTS (
            SELECT 1 FROM pg_index WHERE indrelid = archive AND NOT (indisvalid AND indisready AND indislive)
        ) THEN
            RAISE EXCEPTION 'Unexpected existing provider_response indexes';
        END IF;

        PERFORM set_config('search_path', original_search_path, true);
        RETURN;
    END IF;

    CREATE TABLE "public"."provider_response" (
        "id" text PRIMARY KEY NOT NULL,
        "job_id" text NOT NULL,
        "job_item_id" text,
        "artist_id" text,
        "provider" text NOT NULL,
        "attempt" integer NOT NULL,
        "ordinal" integer NOT NULL,
        "phase" text NOT NULL,
        "method" text NOT NULL,
        "request_url" text,
        "request_key" text,
        "status" integer,
        "received_at" timestamp,
        "content_type" text,
        "retry" integer,
        "not_found" boolean DEFAULT false NOT NULL,
        "body_state" text NOT NULL,
        "retained_bytes" integer NOT NULL,
        "body" jsonb NOT NULL,
        CONSTRAINT "provider_response_sequence_check" CHECK ("provider_response"."attempt" > 0 and "provider_response"."ordinal" > 0),
        CONSTRAINT "provider_response_body_state_check" CHECK ("provider_response"."body_state" = "provider_response"."body"->>'state'),
        CONSTRAINT "provider_response_size_check" CHECK ("provider_response"."retained_bytes" between 0 and 16777216)
    );

    ALTER TABLE "public"."provider_response"
        ADD CONSTRAINT "provider_response_job_id_scrape_job_id_fk"
        FOREIGN KEY ("job_id")
        REFERENCES "public"."scrape_job"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "public"."provider_response"
        ADD CONSTRAINT "provider_response_job_item_id_scrape_job_item_id_fk"
        FOREIGN KEY ("job_item_id")
        REFERENCES "public"."scrape_job_item"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "public"."provider_response"
        ADD CONSTRAINT "provider_response_artist_id_artist_id_fk"
        FOREIGN KEY ("artist_id")
        REFERENCES "public"."artist"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "provider_response_job_order_idx"
        ON "public"."provider_response" USING btree ("job_id","attempt","ordinal","id");
    CREATE UNIQUE INDEX "provider_response_item_attempt_uidx"
        ON "public"."provider_response" USING btree ("job_id","job_item_id","attempt","ordinal") WHERE "provider_response"."job_item_id" is not null;
    CREATE UNIQUE INDEX "provider_response_task_attempt_uidx"
        ON "public"."provider_response" USING btree ("job_id","attempt","ordinal") WHERE "provider_response"."job_item_id" is null;
END;
$migration$;
