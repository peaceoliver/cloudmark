-- Close every table in the public schema to Supabase's REST API (anon / authenticated roles).
-- RLS is on with no policies, so those roles see no rows. The server connects as the table owner
-- (postgres via Supavisor), which RLS does not restrict, and the pg_cron job also runs as postgres.
-- Runs on every start, so tables added later are covered too. Idempotent.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- The cron helper only needs to be callable by postgres, not through the public API.
DO $$
BEGIN
  IF to_regprocedure('public.notification_work_pending()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.notification_work_pending() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;
