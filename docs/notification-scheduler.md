# Értesítések ütemezése (Supabase pg_cron)

A Render free példány tétlenül elalszik, ezért az emlékeztetők időzítése az adatbázisban fut.
A Supabase `pg_cron` percenként megnézi a `notification_work_pending()` függvénnyel, van-e teendő,
és csak akkor hívja meg (`pg_net`) a szerver belső végpontját. Az alvó szerver ettől felébred
(ez 30–60 másodpercig tarthat), és kiküldi az esedékes emlékeztetőket és napi összefoglalókat.
Amíg a szerver ébren van, percenként magától is körbenéz.

## 1. Titok a Renderen

Render → a CloudMark szolgáltatás → Environment: új változó `CRON_SECRET`, hosszú véletlen értékkel
(pl. `openssl rand -hex 32`). Ha nincs beállítva, a belső végpont 503-at ad, és csak a szerver
saját percenkénti köre fut (amíg ébren van).

Ajánlott az `APP_URL` beállítása is (pl. `https://cloudmark.onrender.com`), hogy az e-mailekben
lévő linkek mindig a helyes címre mutassanak.

## 2. Ütemezés a Supabase-ben (SQL Editor)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Ugyanaz az érték, mint a Render CRON_SECRET változója.
select vault.create_secret('<CRON_SECRET értéke>', 'cloudmark_cron_secret');

select cron.schedule(
  'cloudmark-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://cloudmark.onrender.com/api/internal/notifications/run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudmark_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  where public.notification_work_pending();
  $$
);
```

Ellenőrzés: `select * from cron.job_run_details order by start_time desc limit 5;`
és `select * from net._http_response order by created desc limit 5;`

Kikapcsolás: `select cron.unschedule('cloudmark-notifications');`

## Telefonos (push) értesítések

A push értesítéshez egy kulcspár kell (VAPID). Egyszer kell legenerálni:

```sh
npx web-push generate-vapid-keys
```

Render → Environment:
- `VAPID_PUBLIC_KEY` – a nyilvános kulcs
- `VAPID_PRIVATE_KEY` – a privát kulcs (titok)
- `VAPID_SUBJECT` – opcionális, egy elérhetőség a push szolgáltatók felé (`mailto:…` vagy `https://…`). Ha nincs megadva, az `APP_URL`.

Ha a kulcsok hiányoznak, a push csatorna kikapcsolt, minden más működik. A kulcsot később ne cseréld le, mert akkor minden eszközön újra be kell kapcsolni az értesítést.

## E-mail korlát

Saját, hitelesített domain nélkül a Resend csak a fiók tulajdonosának e-mail címére kézbesít.
Más felhasználók csak a felületen belüli (csengő) értesítést kapják meg, amíg nincs domain.
