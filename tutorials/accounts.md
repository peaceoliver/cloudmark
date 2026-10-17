# Fiókok és jelszavak

A **Fiókok** nézetben azt tartod nyilván, melyik oldalon milyen felhasználónévvel vagy melyik fiókkal (Google, GitHub,
Microsoft…) regisztráltál, és az otthoni eszközök (router, Raspberry Pi, Portainer, Jellyfin) belépési adatait. A jelszót
és a titkos megjegyzést a böngésződ titkosítja a **mesterjelszóval**, mielőtt a szerverre küldené: a szerver és az
adatbázis csak olvashatatlan adatot lát.

## Így kezdj hozzá

1. Nyisd meg a **Fiókok** fület (ötödik fül, Alt+5).
2. Kattints a **Széf létrehozása** gombra, és adj meg egy mesterjelszót (legalább 10 karakter). Ez **nem** a belépési
   jelszavad: válassz egy másikat, amit nem használsz máshol.
3. A program ad egy **helyreállító kulcsot** (pl. `KM79-F4RY-…`). Írd le vagy töltsd le (**Letöltés (.txt)**), és tedd
   biztos helyre. Csak ezzel tudsz új mesterjelszót beállítani, ha elfelejted.
4. Pipáld be az „Elmentettem vagy leírtam a helyreállító kulcsot” jelölőt, majd **Kész**.
5. Kattints az **Új fiók hozzáadása** sávra, és töltsd ki:
   - **Név** (pl. GitHub, Router), **Cím** (URL vagy IP, pl. `192.168.1.1:9443`);
   - **Belépés módja**: saját jelszóval, Google-, GitHub-, Microsoft-, Apple-, Facebook-fiókkal, céges SSO-val, SSH kulccsal
     vagy egyéb;
   - **Felhasználónév / e-mail**, illetve külső fióknál **Melyik fiókkal?** (pl. melyik Gmail címeddel);
   - a **Titkosított adatok** részben a **Jelszó** és a **Titkos megjegyzés** (pl. helyreállító kódok, PIN).
6. **Mentés**. A kártyán a cím, a felhasználónév és a jelszó egy-egy sor; a 📋 gomb másol, a 👁 megmutatja a jelszót.

## A széf zárolása és feloldása

- Frissítés vagy új eszköz után a széf **zárolva** van: a nevek, címek és felhasználónevek látszanak, a jelszavakhoz kattints
  a **Feloldás** gombra és add meg a mesterjelszót.
- A széf tétlenség után magától zárol (alapból 15 perc). Ezt a **⋮ → Beállítások… → Fiókok** fülön állíthatod
  (5 perc, 15 perc, 1 óra vagy soha). Az eszköztár lakat gombjával bármikor kézzel zárolhatod.
- Másolás után a jelszó 30 másodperc múlva törlődik a vágólapról.

## Erős jelszó generálása

A jelszómező melletti 🎲 gomb új, erős jelszót készít. Alatta állíthatod a hosszát (8–64) és azt, hogy legyenek-e
benne nagybetűk, számok és jelek; az **Új jelszó** gomb újat készít. A mező alatti sáv mutatja, mennyire erős a jelszó.

## Import és export

- **Import (⋮ → Import (CSV vagy JSON)):** Chrome / Edge, Firefox és Bitwarden exportot, valamint a saját CloudMark CSV-t ismeri fel.
  A jelszavakat a böngésző titkosítja, mielőtt bármi a szerverre menne. Import után töröld az eredeti CSV fájlt, mert abban
  olvasható a jelszó.
- **Export:** az **Export (titkosított JSON)** biztonsági mentésnek jó (a jelszavak titkosítva maradnak, a mesterjelszóval
  vagy a helyreállító kulccsal nyitható meg újra). Az **Export CSV (titkosítatlan)** olvasható jelszavakat tartalmaz, ezért előtte újra meg kell adnod
  a mesterjelszót.

## Elfelejtett mesterjelszó

1. **⋮ → Beállítások… → Fiókok → Elfelejtett mesterjelszó**.
2. Írd be a helyreállító kulcsot és az új mesterjelszót.
3. A helyreállító kulcs ezután is érvényes marad; ha úgy gondolod, valaki látta, kérj **Új helyreállító kulcs**-ot.

Ha a mesterjelszót és a helyreállító kulcsot is elvesztetted, a jelszavakat senki nem tudja visszaállítani. Ekkor a
**Széf törlése…** (a belépési jelszavaddal) törli a széfet és az összes tárolt jelszót; a fiókok neve, címe és
felhasználóneve megmarad, és új széfet hozhatsz létre.

## AI kitöltés

Az űrlap ✨ gombja a név és a cím alapján javaslatot ad a névre, leírásra, belépési módra, kategóriára és címkékre (ha a
Beállítások → AI fülön megadtad a kulcsodat). A felhasználónevet, a jelszót és a titkos megjegyzést az AI **soha nem kapja meg**.

## Tippek

- A Ctrl+K keresőben a fiókok is megjelennek: az Enter a felhasználónevet, a Shift+Enter a jelszót másolja (zárolt széfnél
  előbb a feloldás jön). `@fiók` szóval csak a fiókok között keresel.
- Telefonon a jobb alsó + gomb nyitja az új fiók űrlapját, a szűrők a **Szűrők** gomb alatt vannak.
- A fiókok nem oszthatók meg másokkal (a titkosítás miatt).

## Gyakori kérdések

**Látja a jelszavaimat a szerver üzemeltetője?** Nem. A mesterjelszóból a böngésző kulcsot számol (PBKDF2, 600 000 kör),
és csak a titkosított adatot küldi el. Egy adatbázis-mentésből sem olvashatók ki.

**Mi történik, ha valaki belép a CloudMark fiókomba?** Látja a fiókok nevét, címét és felhasználónevét, de a jelszavakhoz a
mesterjelszó kell. A mesterjelszót a belépett munkamenet sem tudja megváltoztatni, csak egy feloldott széf.
