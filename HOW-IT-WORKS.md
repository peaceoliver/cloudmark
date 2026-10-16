# CloudMark - az oldal működése

Lépésről lépésre útmutatók funkciónként: [tutorials/](tutorials/README.md).

A CloudMark egy többfelhasználós könyvjelző-kezelő alkalmazás. Bejelentkezés után saját kategóriákba rendezve lehet weboldalakat menteni, keresni és kezelni, valamint parancsokat és jegyzeteket tárolni.

## Könyvjelző mentése

Új könyvjelzőhöz meg kell adni a címet, az URL-t és egy kategóriát. Opcionálisan leírás és címkék is megadhatók.

- A kézzel megadott **Cím** lesz a könyvjelző fő címe.
- A kézzel megadott **Leírás** változatlanul elmentődik és megjelenik a kártyán.
- Azonos URL ugyanahhoz a felhasználóhoz egyszer menthető el.
- Könyvjelzőt a gyorsmentő (bookmarklet) is elő tud készíteni az aktuális oldal URL-jével és címével.

## Automatikus weboldal-adatok

A Beállítások ablak Könyvjelzők fülén külön kapcsolható:

- **Weboldal címsor olvasása:** mentéssel vagy szerkesztéssel az oldal `og:title`, `twitter:title` vagy HTML-címe beolvasható. Ha nincs kézzel megadott cím, ezt használja fő címnek.
- **Weboldal kép olvasása:** az oldal `og:image` vagy `twitter:image` képe beolvasható és kártyaképként jelenhet meg.

Ha a leírás mezőt üresen hagyod, az oldal meta-leírása is elmenthető. A kézzel beírt leírás mindig elsőbbséget élvez.

Az automatikus beolvasás nem garantált: az oldal blokkolhatja a lekérést, vagy nem adhat meg megfelelő metaadatot.

## Megjelenítés és rendezés

A könyvjelzők kártya-, kompakt- vagy listanézetben jelennek meg. A képek külön elrejthetők/megjeleníthetők. Keresés működik címre, URL-re, kategóriára, leírásra és címkére.

Rendezési lehetőségek:

- legújabb vagy legrégebbi elöl;
- ABC-sorrend cím szerint;
- leggyakrabban megnyitott.

## Állapotok és kezelés

Egy könyvjelző lehet aktív, kedvenc, későbbi olvasásra jelölt, ellenőrzésre váró, archivált vagy kukába helyezett. A kijelölt könyvjelzők csoportosan is módosíthatók vagy más kategóriába mozgathatók.

## Nézetek: Könyvjelzők, Parancsok, Jegyzetek, Feladatok

Bejelentkezés után a főoldal tetején lehet váltani a négy nézet között, ebben a sorrendben: Jegyzetek, Feladatok, Könyvjelzők, Parancsok (gyorsbillentyű: Alt+1 … Alt+4, a fülek sorrendjében). Első belépéskor a Jegyzetek nyílik meg. A választott nézet frissítés után is megmarad, hacsak a Beállításokban nincs megadva egy fix induló nézet („Induláskor megnyíló nézet”, `startView`). Mindegyik nézetben a `/` billentyű a keresőbe ugrik.

Mind a négy nézet teteje ugyanúgy épül fel: legfelül az egyforma „+ Új …” sáv (Könyvjelzők és Parancsok: a sáv alatt lenyíló űrlap; egy meglévő parancs szerkesztése ablakban nyílik, Jegyzetek: a szerkesztő közvetlenül a sáv alatt nyílik meg, Feladatok: gyors beírás), alatta a kategóriák (Feladatoknál a projektek), alatta a keresés, végül egy sorban a rendezés, az állapotok (pl. Aktív / Kedvencek / Kuka) és a nézetváltó, a sor végén a ⋮ menüvel.

- **⋮ menü:** mind a négy nézetben ugyanott van, a sor végén: kategóriák kezelése (Feladatoknál projektek), az adott nézet importja és exportja, a végén **Beállítások…**, amely a közös Beállítások ablakot az adott nézet fülén nyitja meg.
- **Nézetváltó:** Parancsoknál Normál / Kompakt / Lista, Jegyzeteknél ezen felül Kanban, Feladatoknál Lista / Kompakt. Kompakt parancsnál csak a kód első sora látszik; lista nézetben a sorra kattintva nyílik ki a kód. Kompakt feladatnál a dátum/projekt sor rejtve van.
- **Rendezés:** Parancsok: legújabb, ABC, leggyakrabban másolt. Jegyzetek: utoljára módosított, legújabb, ABC. Feladatok: határidő, prioritás, legújabb, ABC (a csoportokon, pl. Ma / Holnap, belül).
- **Kártyák:** mind a négy nézetben a kategória (Feladatoknál a projekt) kék címkeként a cím alatt, bal oldalt látszik, a címkék pedig `#címke` formában, kék szöveggel a kártya alján (a Parancsok mintájára). Kompakt jegyzetnél és kompakt feladatnál a címkék rejtve vannak.
- A választott rendezés és nézet nézetenként a fiókhoz mentődik (`commandSort`, `commandView`, `noteSort`, `noteView`, `taskSort`, `taskView`), így minden eszközön ugyanaz.

### Keresés mindenhol (Ctrl+K)

A **Ctrl+K** (Macen ⌘K) bármelyik nézetből, vagy a fejléc nagyító gombja (telefonon is) megnyit egy keresőablakot, amely egyszerre keres a jegyzetekben, feladatokban, könyvjelzőkben és parancsokban: címben, szövegben, leírásban, kategóriában, címkében és parancskódban, ékezet nélkül is (a „kazan” megtalálja a „Kazán”-t). A találatok típusonként (legfeljebb 5) csoportosítva jelennek meg, a fülek sorrendjében.

- **↑/↓** lépked, **Esc** bezár, **Enter**: jegyzetnél megnyitja a szerkesztőt, feladatnál a részletes panelt, könyvjelzőnél új lapon a weboldalt, parancsnál a kódot a vágólapra másolja (és növeli a használatszámot). **Shift+Enter**: könyvjelző vagy parancs szerkesztése.
- **Létrehozás:** a lista alján mindig ott van „Új jegyzet / feladat / könyvjelző / parancs” a beírt szöveggel. Az új feladatot a gyors beírás értelmezője dolgozza fel (pl. „holnap 9 számla !1 #pénzügy”); ha a szöveg webcím, az új könyvjelző azzal töltődik ki.
- **Üres mezőnél** a legutóbb megnyitott elemek látszanak (a böngészőben tárolva).
- **`>` előtaggal** gyors műveletek jönnek: nézetváltás, Beállítások, téma váltása, új elem.
- A feladat „Kapcsolt elemek” keresője ugyanezt a közös keresőt használja.

### Beállítások

Egy közös ablak hat füllel; a fejléc ⋮ menüjéből (Általános fül) vagy bármelyik nézet ⋮ menüjéből (az adott nézet füle) nyílik.

- **Általános:** téma, induláskor megnyíló nézet, értesítések (e-mail, napi összefoglaló, telefonos értesítés eszközönként, csendes időszak, teszt értesítés), jelszócsere. Az értesítési kapcsolók azonnal mentődnek; a csengő panel alján egy link vezet ide.
- **Jegyzetek, Feladatok, Parancsok:** alapértelmezett rendezés és nézet.
- **AI:** saját AI kulcsok (Gemini, Claude, OpenAI-kompatibilis) az AI kitöltéshez, modellválasztás, kapcsolat tesztelése.
- **Könyvjelzők:** nézet, rendezés, weboldal címsor és kép olvasása, az export tartalma és az import célkategóriája, valamint a „Mentés CloudMarkba” gyorsmentő gomb.
- A fejléc ⋮ menüjében csak az általános dolgok maradtak: Beállítások, Team, alkalmazás telepítése, Info. Az **Info** egy rövid ismertető mind a négy nézetről, a keresőről, a menükről és a gyorsbillentyűkről.

### Parancsok

Gyakran használt parancssorok tárolása, kategóriákba rendezve.

- **Soronkénti másolás:** minden sor mellett van egy másológomb, amely a `#` utáni kommentet levágja.
- **Többsoros parancsnál:** „Összes másolása”, valamint a ⋮ menüben „Másolás Markdownként” és „Kommentek nélkül”.
- **Fülek:** egy parancsnak több változata lehet (pl. CMD / PowerShell / bash), mindegyik saját nyelvvel. A kártyán egy fülnél a nyelv címke a kategória mellett látszik, több fülnél a fülek nevén. A szerkesztőben a Nyelv mezőre kattintva a teljes javaslatlista megjelenik.
- Kedvencek, kuka, rendezés (legújabb, ABC, leggyakrabban másolt), keresés, kategóriák alapnyelvvel.
- Import / export JSON-ban, export Markdownban (⋮ menü). Új parancs: `N`.
- **AI kitöltés** (ha van aktív AI kulcs): bemásolt parancsból kitölti a címet, leírást, címkéket, kategóriát és nyelvet; vagy a címbe / leírásba írt célból megírja a parancsot is, és a címet, leírást rendes szövegre javítja. Javasolhat egy további fület (pl. PowerShell változat; ilyenkor a névtelen első fül a nyelvéről kap nevet, pl. „Bash”) és új kategóriát. A javaslat kiemelve kerül a mezőkbe (Elfogadom / Visszavonom), alapból csak az üres mezőkbe; menteni a Mentés gomb ment.

### AI kitöltés saját kulccsal

- Minden felhasználó a saját kulcsát adja meg (Beállítások → AI). A kulcsot a szerver AES-256-GCM titkosítással tárolja (`AI_KEY_ENCRYPTION_SECRET`), a böngésző soha nem kapja vissza; az admin biztonsági mentésbe nem kerül bele.
- Az AI-t a szerver hívja (`POST /api/ai/fill`), rögzített JSON sémával, és a választ még egyszer ellenőrzi: csak az engedélyezett mezők, meglévő kategória, legfeljebb 5 címke, legfeljebb 1 új fül.
- Ajánlott modellek: Gemini Flash (`gemini-flash-latest`, van ingyenes szint), Claude Haiku 5.5 (`claude-haiku-5-5`). A listát a szolgáltatótól kéri le.
- Ha a szolgáltató túlterhelt (pl. Gemini 503), a szerver kétszer újrapróbálja rövid várakozással, Geminin utána a Flash-Lite modellel is.
- Korlát: 10 AI kérés percenként felhasználónként, kb. 8000 karakter bemenet. Az audit naplóba csak a művelet és a szolgáltató kerül, a szöveg nem.

### Jegyzetek

Google Keep-szerű jegyzetek.

- A „Jegyzet írása…” mezőbe kattintva gyorsan új jegyzet írható. Kívülre kattintva automatikusan mentődik.
- Szöveges jegyzet vagy jelölőnégyzetes lista. A kettő között egy gombbal lehet váltani.
- Háttérszín, rögzítés (a rögzített jegyzetek felül), címkék, archiválás, kuka.
- Kategóriák: a jegyzetek fölötti sorban „Összes”, „Kategória nélkül” és a saját kategóriák szűrnek, darabszámmal. Új kategória a „+” gombbal vagy a szerkesztő kategória-választójában („+ Új kategória…”) hozható létre. A kategória melletti ⋮ menüben átnevezhető vagy törölhető; törléskor a jegyzetei megmaradnak, és a „Kategória nélkül” szűrőbe kerülnek. A jegyzetkategóriák külön vannak a parancsok kategóriáitól (`categories.kind = 'note'`).
- Egy jegyzetre kattintva megnyílik a szerkesztő, ami gépelés közben automatikusan ment.
- **Kanban nézet:** oszloponként egy kategória („Kategória nélkül” + a saját kategóriák). Egy jegyzetet másik oszlopba húzva a kategóriája megváltozik és azonnal mentődik (egérrel húzással, telefonon hosszú nyomás után húzással; a tábla széléhez érve az oszlopok továbbgördülnek). Az oszlop alján a „+ Jegyzet” abba a kategóriába nyit új jegyzetet, a sor végén „Új kategória” oszlop hozható létre. Ha fent egy kategória van kiválasztva, csak az az oszlop látszik.
- A Jegyzetek ⋮ menüjében: új kategória, import (JSON) és export (JSON, Markdown).

### Feladatok

Teendők határidővel, ismétlődéssel és részfeladatokkal. A fülön lévő szám a mai és a lejárt feladatok számát mutatja.

- **Gyors felvétel magyarul:** a felső mezőbe egy mondatban beírható minden, gépelés közben alatta látszik, mit ismert fel. Példák:
  - `holnap 9-kor számla befizetése !1 #pénzügy @Otthon`
  - `minden hétfőn heti tervezés`, `minden hónap 1-jén lakbér`, `kéthetente szemét`
  - `jövő szerdán fél 3-kor fogorvos ^30` (emlékeztető 30 perccel előtte)
  - `!1`–`!4` prioritás, `#címke`, `@Projekt` (ha nincs ilyen projekt, létrejön).
- **Okos listák:** Ma (a lejártakkal együtt), Következő 7 nap, Beérkezett (projekt nélküliek), Mind, Kész, Kuka.
- **Projektek:** a listák alatt, a ⋮ menüben átnevezhetők és törölhetők.
- **Részletek:** egy feladatra kattintva jobb oldalt megnyílik a panel, ami automatikusan ment. Itt állítható a határidő és időpont, az ismétlődés, a prioritás, a projekt, az állapot, az emlékeztetők, a részfeladatok és a kapcsolt jegyzetek, parancsok, könyvjelzők.
- **Kipipálás:** az ismétlődő feladat a következő esedékességre ugrik (a részfeladatai újra nyitottak lesznek). Alul „Visszavonás” gomb jelenik meg.
- **Billentyűk:** `N` új feladat, `/` keresés, a listában `↑`/`↓` mozgás, `Enter` részletek, `szóköz` kész, `T` áthelyezés mára, `Esc` panel bezárása.
- **Értesítések:** az esedékes emlékeztető megjelenik a fejléc csengő ikonjánál, a telefonodon vagy gépeden rendszerértesítésként (ha bekapcsoltad), és e-mailben is (ha az e-mail címed meg van erősítve). A csengőre kattintva látod az értesítéseket, egy értesítésre kattintva megnyílik a feladat.
- **Telefonos értesítés:** a Beállítások → Általános fülön (a csengő panel alján lévő linkről is elérhető) az „Értesítések ezen az eszközön” kapcsolóval, eszközönként kapcsolható be. iPhone-on előbb telepíteni kell az appot (lásd lent), és a kezdőképernyőről megnyitva kell bekapcsolni. Az értesítésen **Kész** és **Szundi 10 perc** gomb van (iPhone-on a gombokat az Apple nem jeleníti meg, ott koppintásra megnyílik a feladat). Ugyanez a két gomb az e-mailben is ott van.
- **Szundi:** a feladat panelén a „Szundi 10 perc” gombbal 10 perc múlva újra szól.
- **Csendes időszak:** a Beállítások → Általános fülön beállítható (pl. 22:00–07:00). Ilyenkor a telefon nem kap értesítést, csak a csengő és az e-mail.
- **Napi összefoglaló:** a Beállítások → Általános fülön bekapcsolható. A választott időpontban e-mailt kapsz a lejárt, mai és holnapi feladataidról. Ugyanitt kapcsolhatók ki az e-mail emlékeztetők, és küldhető teszt értesítés.

## Telepítés alkalmazásként

A CloudMark telepíthető a telefonra és a számítógépre is, ilyenkor saját ikonnal, külön ablakban, böngészősáv nélkül nyílik.

- **Android, asztali Chrome és Edge:** a ⋮ menü „Alkalmazás” részében a **Telepítés** gombbal (vagy a böngésző címsorában megjelenő telepítés ikonnal).
- **iPhone és iPad:** Safariban a **Megosztás** gomb, majd **Hozzáadás a Főképernyőhöz**.
- **Hálózat nélkül:** az app elindul, felül sáv jelzi, hogy nincs kapcsolat; az adatok a kapcsolat visszatérése után töltődnek be.
- **Frissítés:** ha új verzió érhető el, egy „Frissítés” gomb jelenik meg.

## Egyéb lehetőségek

- Saját kategóriák és címkék kezelése (Könyvjelzők ⋮ menü).
- Könyvjelzők importálása JSON- vagy HTML-fájlból.
- Export JSON- vagy HTML-fájlba.
- Megosztható hivatkozás készítése egy könyvjelzőhöz.
- Team funkció és adminisztrációs lehetőségek jogosultságtól függően. (Fejlesztés alatt)
