# CloudMark roadmap

## Valós projekt állapot (2026.09.03)

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

## 2. Részben kész ⚠️

- rich preview / előnézet — metaadat-fetch (cím, kép, leírás, oldalnév) megvan, de UI preview modal nincs végigvezetve
- audit log — az adatgyűjtés és admin lekérdezés megvan, de nincs hozzá szűrhető/kereshető admin UI felület
- backup/restore — export/import endpoint megvan, de nincs ütemezett/automatikus backup, sem offsite mentés
- import/export — JSON és HTML export működik, de nincs tesztelve/garantálva a teljes Chrome/Firefox export kompatibilitás minden változatra
- e-mail küldés HTTPS API providerrel — a kód kész és tesztelve saját címre, de éles (bármely felhasználónak történő) küldéshez saját, ellenőrzött domain kell a Resend/SendGrid oldalon — **ez még nincs beállítva, domain vásárlása elhalasztva**

## 3. Még hiányzik ❌

- valódi mappák / collections (jelenleg csak lapos kategória-hierarchia van, nincs bookmark-szintű beágyazott mappa nézet)
- RBAC bővítése (guest szerepkör, finomabb jogosultsági szintek a jelenlegi admin/user/team_admin felett)
- SSO / OAuth2 / OIDC bejelentkezés (Google, Microsoft, GitHub)
- 2FA / MFA
- rate limiting és brute-force védelem (login endpointokon nincs korlátozás)
- security hardening: helmet/CSP, CSRF védelem, security headerek — jelenleg nincs beállítva
- token rotation / session lejárat finomhangolása
- teljesen validált keresés cím+URL+kategória+címke+leírás kombinációban UI szinten
- search index bővítés (jelenlegi Postgres full-text alapszintű, nincs Elastic/OpenSearch)
- caching réteg (Redis vagy hasonló)
- szerver-oldali/cursor-alapú lapozás (jelenleg csak kliens-oldali lapozás van, minden könyvjelző lekérdezésre kerül a szerverről)
- lazy loading képekhez, CDN/image proxy
- job queue / async background worker (pl. metadata fetch háttérben)
- application monitoring, error tracking (pl. Sentry)
- browser extension (Chrome/Firefox)
- mobil app
- webhookok, Slack/Teams/Discord értesítések
- AI alapú címke/összefoglaló generálás

## 4. Következő prioritások

1. Saját domain beszerzése és Resend/SendGrid domain-hitelesítés → valódi e-mail küldés minden felhasználónak (jelenleg elhalasztva)
2. Rate limiting és alap security hardening (helmet, CSP, login brute-force védelem)
3. Audit log admin UI (szűrés, keresés a meglévő audit_events adaton)
4. Rich preview modal a meglévő metaadatokból
5. Automatikus/ütemezett backup a meglévő export endpointra építve
6. Valódi mappa/collection hierarchia a bookmarkokhoz
7. Pagination és caching a teljesítmény javításához
8. SSO/2FA biztonsági réteg
