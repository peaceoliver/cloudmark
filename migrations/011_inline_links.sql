-- Belső hivatkozások ([[ link): a szövegből kiolvasott linkek is az item_links táblába kerülnek.
-- origin = 'manual': a feladat „Kapcsolt elemek” részében kézzel felvett kapcsolat (a meglévő sorok mind ilyenek),
-- origin = 'inline': a jegyzet / feladat szövegében lévő [[…]] link; mentéskor a szerver újraszámolja.
ALTER TABLE item_links ADD COLUMN IF NOT EXISTS origin VARCHAR(10) NOT NULL DEFAULT 'manual';

DO $$
DECLARE
  pk_name TEXT;
  pk_columns INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_links_origin_check') THEN
    ALTER TABLE item_links ADD CONSTRAINT item_links_origin_check CHECK (origin IN ('manual', 'inline'));
  END IF;
  -- Ugyanaz a cél lehet kézi és szövegbeli link is, ezért az origin a kulcs része.
  SELECT conname, array_length(conkey, 1) INTO pk_name, pk_columns
  FROM pg_constraint WHERE conrelid = 'item_links'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL AND pk_columns = 3 THEN
    EXECUTE format('ALTER TABLE item_links DROP CONSTRAINT %I', pk_name);
    ALTER TABLE item_links ADD PRIMARY KEY (item_id, target_type, target_id, origin);
  END IF;
END $$;
