# CloudMark roadmap

## Valós projekt állapot (2026.09.02)

Ez a projekt már több funkciót tartalmaz, mint a korábbi roadmap sugallta, de még nem az enterprise teljes körű verziója. A legfontosabb, hogy a meglévő funkciók már működő API-s és adatbázis-szintű alapokat adnak, de a biztonsági, admin és skálázhatósági rétegek még hiányoznak.

### 1. Már megvan / működik

- többfelhasználós könyvjelzőkezelés
- kategóriák
- keresés és szűrés
- rendezés
- nézetválasztás (kártya, kompakt, lista)
- felhasználói beállítások
- jelszóváltoztatás
- admin SMTP konfiguráció
- metadata fetch (cím, kép, leírás, site name)
- session-alapú autentikáció
- könyvjelző állapotok: inbox, read_later, to_review, done
- kedvencek / starred
- archiválás, törölt elemek
- tag-ek / címkék
- import/export (JSON + HTML/Netscape export)
- duplikát észlelés
- URL validáció és normalizálás
- admin role és ACL alapok

### 2. Részben megvan / nincs teljesen befejezve

- mappák / könyvtárstruktúra helyett kategóriák
  - a kategória logika már is működik, de nincs hierarchikus folder / collection model
- rich preview / előnézet
  - metaadatok vannak, UI preview nincs teljesen végigvezetve
- enterprise role model
  - admin/user alapok vannak, de nincs team, tenant, guest vagy bővített RBAC
- backup / restore
  - nincs valódi adatmentési és visszaállítási fluss
- import/export szélesebb formátumokból
  - HTML/JSON alapok működnek, de a teljes Chrome/Firefox export kompatibilitás és több formátum még nincs teljesen kezelve

### 3. Még hiányzik az enterprise használathoz

- keresés cím, URL, kategória, címke és leírás alapján a teljes egészében validált UI+API szinten
- valódi mappák / collections / folder hierarchy
- feladatok / read later / to review teljes workflow és UX
- rich preview / bookmark modal
- jobb bulk actions és admin műveletek
- audit log és kibővített user activity tracking
- SSO / OAuth2 / OIDC (Google, Microsoft, GitHub)
- 2FA / MFA
- rate limiting és brute-force védelem
- session management, token rotation és security hardening
- backup és restore, offsite backup, disaster recovery
- GDPR / adatvédelmi és törlési követelmények teljes körű megvalósítása
- teljesen ellenőrzött deployment és monitoring

### 4. Biztonság és jogkezelés

- RBAC: admin, user, guest, team admin
- SSO / OAuth2 / OIDC
- 2FA / MFA
- session management és token rotation
- rate limiting és brute-force védelem
- audit log: ki, mit, mikor módosított
- GDPR / adatvédelmi megfontolások
- adatbontás, export és törlés teljes körű támogatása
- HTTPS-only, secure headers, CSP, CSRF védelem
- titkosítás a DB-ben és az érzékeny adatoknál
- IP / user agent logging

### 5. Performance és skálázhatóság

- DB indexelés
- pagination / cursor-based loading
- lazy loading képekhez
- CDN / image proxy
- caching
- job queue metadata fetchhez
- async background workers
- API rate limiting
- bulk import / bulk update
- search index (Postgres full-text vagy Elastic/OpenSearch)

### 6. UX és produktiv használat

- gyors kereső a főoldalon
- Open all in tabs
- hover actions
- drag & drop kategóriák között
- keyboard shortcuts
- dark/light mode és jobb accessibility
- responsive design
- listanézet stabilizálása és compact templates
- bookmark preview modal
- quick add modal
- shareable bookmarks / link sharing
- copy URL, copy title, open in new tab, open in background tab

### 7. Adatmodell és backend bővítés

- users
- teams / organizations
- folders / collections
- bookmarks
- tags
- comments / notes
- bookmarks_history
- audit_events
- sessions
- settings
- notifications

### 8. Integrációk és automatizáció

- browser extension
- Chrome/Firefox add-on
- mobile app
- bookmark import API
- webhookok
- Slack / Teams / Discord értesítések
- AI asszisztens a címkék és összefoglalók generálásához
- URL metadata enrichment service
- OCR / article summary
- AI recommended tags és readable title suggestions

### 9. Admin és operációs funkciók

- user management
- team management
- role management
- usage analytics
- storage usage
- failed fetch logs
- cron jobs
- Sentry / error tracking
- application health monitoring
- backpressure handling
- DB backups and restore
- deployment pipeline

### 10. Következő prioritások

1. Duplikát logika és URL normalizálás véglegesítése
2. Tags + status + archived/trashed UX és stabilitás
3. Team/tenant role model és admin szintű kezelés
4. Audit log és backup/restore
5. Rich preview és bulk actions
6. Search index és performance
7. SSO, MFA és biztonsági hardening
8. Browser extension és import API

### 11. Konkrét roadmap

- Fázis 1: stabil alap
  - keresés és deduplication stabilizálása
  - címkék, status és archiválás
  - import/export és adatnormalizálás

- Fázis 2: team és admin
  - teams / organizations
  - RBAC és user management
  - audit log
  - backup/restore

- Fázis 3: scale and platform
  - API v1
  - browser extension
  - background jobs
  - caching és search index
  - observability

- Fázis 4: AI and productivity
  - AI title / tag suggestion
  - article summary
  - smart collections


&#x20; - notes + semantic search

&#x20; - recommendation engine



10\. Jelenlegi projekt erősségei

\- gyorsan működő MVP

\- látványos UI

\- több felhasználós alap

\- jó admin felület

\- beállítások és autentikáció már megvan

\- jól bővíthető server + frontend architektúra



11\. Jelenlegi projekt gyengeségei

\- nincs teljes keresés

\- nincs tag / note / archive

\- nincs bulk ops és import/export

\- nincs team / org / RBAC

\- nincs enterprise audit

\- nincs valódi monitoring

\- nincs dokumentált API és SDK

\- nincs automatikus metadata pipeline optimalizálva

\- nincs nyilvános és privát könyvjelzők kezelése



12\. A legfontosabb következő 10 feladat

\- kereső és szűrő rendszer

\- címkék és notes

\- import/export

\- archiválás és duplikát észlelés

\- RBAC és team szintek

\- audit log

\- API dokumentáció

\- teljes monitoring és error tracking

\- background metadata worker

\- browser extension



13\. Ajánlott végső irány

Ha ezt enterprise termékké szeretnéd fejleszteni, akkor az ajánlott irány:

\- Postgres + Redis + background worker + browser extension + SSO + audit log + search

\- v1-ben stabil, jól használható “bookmark management platform”

\- v2-ben AI + team + organization + analytics + import/export



14\. Rövid konklúzió

Most a projekt már nem csak egy demo, hanem egy működő MVP. Az a következő különbség, hogy enterprise szintre emelkedjen:

\- protokoll, biztonság, audit, skálázás, import/export, search, teams, automation, monitoring



Ha szeretnéd, a következő lépésben tudok csinálni egy konkrét:

\- roadmapet 90 napra

\- product backloget

\- feature listet prioritással (P0/P1/P2)

\- vagy egy “enterprise architecture plan” dokumentumot, amelyből már ténylegesen fejleszteni lehet.

