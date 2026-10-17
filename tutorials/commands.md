# Kódtár

Kódrészletek egy helyen: parancssorok, SQL, konfiguráció, kód. Egy kattintással másolható, színezve látszik, és bármikor megtalálod (a régi **Parancsok** fül neve most **Kódtár**).

## Így kezdj hozzá

1. Nyisd meg a **Kódtár** fület (Alt+4), vagy nyomd meg az `N` billentyűt.
2. Kattints az **Új kódrészlet hozzáadása** sávra; az űrlap alatta nyílik meg.
3. **Cím:** azt írd, amit keresnél, pl. „Postgres: tétlen kapcsolatok bontása” (a nyelv nem kell bele, az a fül dolga).
4. **Leírás:** egy-két mondat: mire való, honnan van (link), mire figyelj („csak Node 18+”). A kereső ezt is nézi.
5. **Kategória:** a munkaterület (pl. `frontend`, `backend`, `db`, `devops`, `shell`), ha kell alkategóriával (`shell / git`). Ha nem tudod, hagyd Inboxban, később átteheted.
6. **Címkék:** a téma, ami több kategóriában is előjön (`docker`, `regex`, `auth`, `gotcha`).
7. **Kód:** illeszd be. Több változathoz (pl. bash / PowerShell vagy JS / Python) adj hozzá új fület, mindegyiknek saját nyelvvel.
8. Mentsd.

Ha megadtál AI kulcsot, az **✨ AI kitöltés** gomb (Ctrl+Enter) minden mezőt kitölt a bemásolt kódból vagy a címbe írt célból (lásd [ai-assist.md](ai-assist.md)). Alapból csak az üres mezőket, a **Mindent újraír** bejelölésével mindet.

## Keresés

- A Kódtár keresője ékezet nélkül is talál, több szónál mindegyiknek szerepelnie kell.
- `#docker`: csak az ilyen címkéjűek. `/shell`: csak a `shell` kategória és alkategóriái (`shell / git` is). Kombinálható: `stop #docker`.
- Mindenhonnan: **Ctrl+K**, és ugyanezek az előtagok működnek, plusz `@kód` csak a kódrészletekre szűr (lásd [command-palette.md](command-palette.md)). Enter a kódot másolja.

## Az Inbox rendezése

1. Kattints a kategóriák között az **Inbox**-ra (a kategória nélküliek).
2. ⋮ → **Kijelölés és áthelyezés**.
3. Kattints a kártyákra (vagy **Mind**), válaszd ki a kategóriát, majd **Áthelyezés**.
4. **Kész** (vagy Esc).

## Másolás

- Minden sor mellett van egy másológomb: a sort a `#` utáni komment nélkül másolja.
- Többsoros kódnál „Összes másolása”, a ⋮ menüben „Másolás Markdownként” és „Kommentek nélkül”.

## Tippek

- A kód VS Code-szerű színekkel és sorszámokkal jelenik meg, a fül nyelve szerint. Ha nem színez, adj meg nyelvet a fülnek.
- Telefonon a szűrők, a rendezés és a nézet a kereső melletti **Szűrők** gombbal nyílnak, újat a jobb alsó **+** gombbal veszel fel (lásd [mobile.md](mobile.md)).
- Egy meglévő kódrészlet szerkesztése ablakban nyílik.
- Kategóriánként alapnyelv állítható be (⋮ → Kategóriák kezelése).
- A Nyelv mezőbe kattintva a teljes javaslatlista látszik (bash, powershell, cmd, sql, typescript …); más nyelv is beírható.
- Rendezés: legújabb, ABC, leggyakrabban másolt. Nézet: Normál, Kompakt (csak az első sor), Lista.
- Import / export JSON-ban, export Markdownban a ⋮ menüben.
