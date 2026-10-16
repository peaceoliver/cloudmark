# CloudMark roadmap

## Valós projekt állapot (2026.10.16)

A fejlesztési szabályok és a felület egységességének szabályai a `CLAUDE.md`-ben vannak.

## 1. Kész ✅

- többfelhasználós könyvjelzőkezelés (CRUD, státuszok: inbox, read_later, to_review, done)
- session-alapú autentikáció (regisztráció, login, logout, jelszóváltoztatás)
- e-mail megerősítés regisztrációkor
  - SMTP küldés (nodemailer) — **Render-en nem működik**, mert a hosting blokkolja a kimenő SMTP portokat (25/465/587)
  - HTTPS API alapú küldés (Resend/SendGrid) admin panelből választható, ez működik Renderen is
  - ha a küldés sikertelen, a megerősítő link megjelenik a felületen (fallback)
- admin e-mail (SMTP + API provider) konfiguráció és teszt-küldés funkció
- kategóriák, hierarchikus kategória-struktúra (parent_id)
- címkék (tags) és címke-kezelés
- keresés és szűrés (Postgres full-text index cím/URL/leírás alapján)
- rendezés, nézetválasztás (kártya, kompakt, lista)
- felhasználói beállítások
- kedvencek / starred
- archiválás, kuka (soft delete) és végleges törlés
- duplikát URL észlelés és URL normalizálás
- import/export (JSON + HTML/Netscape formátum)
- bookmark megosztás (share token / link sharing)
- bulk műveletek könyvjelzőkön (tömeges státusz/kategória módosítás)
- csapatok (teams): létrehozás, tagok kezelése, csapat admin szerepkör
- admin szerepkör és jogosultság-ellenőrzés (requireAdmin, requireTeamAdmin)
- audit log (audit_events tábla + admin lekérdező endpoint)
- admin backup export/import (teljes adat JSON export/import)
- app-szintű admin konfiguráció (settings_app)
- e-mail megerősítés ki/bekapcsolása admin felületről + regisztrált felhasználók manuális aktiválása/deaktiválása admin panelből
- egységesített, könnyen olvasható csapat (team) kezelő felület (szerepkör-magyarázattal, kártyás nézettel)
- kliens-oldali lapozás a könyvjelző listánál (60 elem/oldal), nagy listáknál is gyors marad a renderelés
- rate limiting (login, regisztráció) és helmet/CSP security headerek
- audit log admin UI (szűrés, keresés)
- Parancsok nézet (masscode-szerű parancskönyvtár, fülek, soronkénti másolás, import/export)
- Jegyzetek nézet (Keep-szerű jegyzetek, listák, színek, kategóriák)
- Feladatok nézet (magyar gyors felvétel, ismétlődés, részfeladatok, emlékeztetők)
- értesítések: csengő, e-mail, napi összefoglaló, Web Push (Supabase pg_cron ütemezéssel)
- PWA: telepíthető app, offline oldal, push értesítés Kész/Szundi gombokkal
- egységes nézetek: fülek, „+ Új …” sáv, eszközsor, kártyák (kategória és #címkék) mind a négy nézetben

## 2. Részben kész ⚠️

- rich preview / előnézet — metaadat-fetch (cím, kép, leírás, oldalnév) megvan, de UI preview modal nincs végigvezetve
- backup/restore — export/import endpoint megvan, de nincs ütemezett/automatikus backup, sem offsite mentés
- import/export — JSON és HTML export működik, de nincs tesztelve/garantálva a teljes Chrome/Firefox export kompatibilitás minden változatra
- `trust proxy` = true, ezért az IP alapú korlátozás megkerülhető, amíg nincs beállítva a Render helyes hop-száma
- e-mail küldés HTTPS API providerrel — a kód kész és tesztelve saját címre, de éles (bármely felhasználónak történő) küldéshez saját, ellenőrzött domain kell a Resend/SendGrid oldalon — **ez még nincs beállítva, domain vásárlása elhalasztva**

## 3. Még hiányzik ❌

- valódi mappák / collections (jelenleg csak lapos kategória-hierarchia van, nincs bookmark-szintű beágyazott mappa nézet)
- RBAC bővítése (guest szerepkör, finomabb jogosultsági szintek a jelenlegi admin/user/team_admin felett)
- SSO / OAuth2 / OIDC bejelentkezés (Google, Microsoft, GitHub)
- 2FA / MFA
- CSRF védelem
- token rotation / session lejárat finomhangolása
- teljesen validált keresés cím+URL+kategória+címke+leírás kombinációban UI szinten
- search index bővítés (jelenlegi Postgres full-text alapszintű, nincs Elastic/OpenSearch)
- caching réteg (Redis vagy hasonló)
- szerver-oldali/cursor-alapú lapozás (jelenleg csak kliens-oldali lapozás van, minden könyvjelző lekérdezésre kerül a szerverről)
- lazy loading képekhez, CDN/image proxy
- job queue / async background worker (pl. metadata fetch háttérben)
- application monitoring, error tracking (pl. Sentry)
- browser extension (Chrome/Firefox)
- natív mobil app (Capacitor), a PWA már telepíthető
- webhookok, Slack/Teams/Discord értesítések
- AI asszisztens (összefoglaló, parancs magyarázat, feladatok kiszedése jegyzetből)

## 4. Következő prioritások

Az aktuális ötletek feladatként vannak felvéve az appban (Feladatok, „CloudMark” projekt). Mindegyikhez előbb terv készül, és csak jóváhagyás után indul a fejlesztés.

1. Teljesítmény ellenőrzés (az oldal megjelenítése lagosnak tűnik)
2. Command Palette (Ctrl+K): közös keresés és gyors létrehozás mind a négy nézetben
3. Belső hivatkozások (`[[`) jegyzetek, feladatok és parancsok között
4. Dashboard kezdőlap (mai/lejárt feladatok, kitűzött jegyzetek, legutóbbi parancsok)
5. Clipper (böngésző gomb és telefonos megosztás menü)
6. Képek és Mermaid ábrák a jegyzetekben
7. AI asszisztens
8. Megosztás más felhasználókkal (e-mail cím, ismerősök vagy a Team funkció alapján), minden elemtípusra
9. Saját domain és e-mail domain-hitelesítés (elhalasztva)
