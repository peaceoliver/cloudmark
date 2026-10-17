# Keresés mindenhol (Ctrl+K)

Egy keresőablak, amely egyszerre keres a jegyzetekben, a feladatokban, a könyvjelzőkben és a kódtárban.
Innen azonnal meg is nyithatod, kimásolhatod vagy létrehozhatod, amit keresel.

## Így kezdj hozzá

1. Nyomd meg a `Ctrl+K`-t (Macen `⌘K`) bármelyik nézetben, vagy kattints a fejléc nagyító gombjára (telefonon is).
2. Kezdd el gépelni, amit keresel. Ékezet nélkül is jó: a „kazan” megtalálja a „Kazán”-t.
3. A találatok típusonként csoportosítva jelennek meg: Jegyzetek, Feladatok, Könyvjelzők, Kódtár.
   Keres a címben, a szövegben, a kategóriában, a címkékben és a kódrészletek minden fülének kódjában is.
4. A `↑`/`↓` billentyűkkel válaszd ki a találatot, és nyomd meg az `Enter`-t:
   - **jegyzet:** megnyílik a szerkesztője,
   - **feladat:** megnyílik a részletes panelje,
   - **könyvjelző:** a weboldal új lapon nyílik meg,
   - **kódrészlet:** a kód a vágólapra kerül.
5. `Esc`-kel bezárod az ablakot.

## Szűkítés előtagokkal

A keresőbe írt szavak elé tett jel szűkíti a találatokat (kombinálható szöveggel és egymással):

- `#docker`: csak a `docker` (vagy így kezdődő) címkéjű elemek.
- `/shell`: csak a `shell` nevű kategóriában vagy annak alkategóriáiban (pl. `shell / git`) lévők.
- `@kód`: csak kódrészletek. Ugyanígy `@jegyzet`, `@feladat`, `@könyvjelző`. Más szó után a `@` kategóriát jelent (mint a feladatoknál a projekt).

Pl. `stop #docker @kód` a „stop” szót keresi a `docker` címkéjű kódrészletekben. Csak szűrővel (szöveg nélkül) típusonként 10 találat jön.
A csoport fejléce mutatja, milyen szűrő van bekapcsolva.

## Új elem létrehozása

A találatok alján mindig ott van a **Létrehozás** csoport a beírt szöveggel:

- **Új jegyzet: „…”**: megnyílik a jegyzetszerkesztő, a beírt szöveg lesz a cím.
- **Új feladat: „…”**: a feladat azonnal létrejön. A szöveget ugyanúgy értelmezi, mint a Feladatok gyors
  beírása, pl. `holnap 9-kor számla !1 #pénzügy @Otthon`.
- **Új könyvjelző**: megnyílik a könyvjelző űrlap. Ha webcímet írtál be, azzal kitöltve.
- **Új kódrészlet: „…”**: megnyílik a kódrészlet űrlap, a beírt szöveg lesz a cím.

Az új jegyzet, könyvjelző és kódrészlet a szűrő-előtagok nélküli szöveget kapja, az új feladat a teljeset (ott a `#címke` és `@projekt` is jelent valamit).

## Tippek

- **Shift+Enter:** könyvjelzőnél és kódrészletnél szerkesztésre nyitja meg az elemet.
- **Üres mező:** a legutóbb megnyitott elemeket mutatja.
- **`>` jellel kezdve** gyors műveletek jönnek: váltás egy másik nézetre, Beállítások, téma váltása, új elem.
  Pl. `>beáll` majd `Enter` megnyitja a Beállításokat.
- A feladat **Kapcsolt elemek** mezője ugyanezt a keresőt használja, ezért ugyanazokat az elemeket találja meg.
- Telefonon a nagyító gomb a fejlécben van, az ablak az egész képernyőt használja.
