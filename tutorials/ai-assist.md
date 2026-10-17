# AI kitöltés saját kulccsal

A saját AI kulcsoddal (Gemini, Claude vagy egy OpenAI-kompatibilis szolgáltató) az **✨ AI kitöltés** gomb
kitölti a Kódtár és a könyvjelzők űrlapját, a feladatoknál és a jegyzeteknél pedig javaslatot ad. Az AI csak a
gomb megnyomására fut, és semmit nem ment el magától.

## Kulcs megadása

1. Szerezz kulcsot:
   - **Gemini (ingyenes):** [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → „Create API key”.
   - **Claude:** [console.anthropic.com](https://console.anthropic.com/settings/keys). A Claude.ai előfizetés (Pro / Max)
     **nem** tartalmaz API hozzáférést, ehhez a Console-ban külön egyenleget kell feltölteni.
   - **OpenAI-kompatibilis:** az adott szolgáltató oldalán (OpenAI, OpenRouter, Mistral, Groq …).
2. Nyisd meg a **Beállítások…** ablakot (bármelyik ⋮ menüből), és válaszd az **AI** fület.
3. Válaszd ki a szolgáltatót, illeszd be a kulcsot (OpenAI-kompatibilisnél a címet is), és kattints a
   **Kulcs mentése és tesztelése** gombra. A CloudMark ellenőrzi a kulcsot, és beállítja az ajánlott modellt.
4. A modellt a kulcs sorában lévő listából cserélheted. A **Teszt** gomb újra lekéri az elérhető modelleket.

Több kulcsot is elmenthetsz; egyszerre egy aktív (**Használom ezt** / **Kikapcsolás**). Ha nincs aktív kulcs,
az AI gomb nem látszik.

## Új kódrészlet kitöltése

1. Kódtár fül → **Új kódrészlet hozzáadása**.
2. Két lehetőség:
   - **Bemásolod a kódot** a Kód mezőbe → az AI kitölti a címet (amire keresnél), a leírást (mire való, buktatók), a címkéket (témák), a kategóriát (munkaterület, pl. `devops`), a nyelvet, és több fülnél a fül nevét.
     A bemásolt kódot nem írja át.
   - **A címbe vagy a leírásba írod, mit szeretnél** (pl. „állítsd le az összes docker konténert”) → az AI megírja a
     parancsot, kitölti a többi mezőt, és a címet, leírást rendes szövegre javítja.
3. Kattints az **✨ AI kitöltés** gombra (vagy nyomd meg a `Ctrl`+`Enter` billentyűt az űrlapon).
4. A javasolt értékek kiemelve jelennek meg. Nézd át, írd át, ha kell, majd **Elfogadom** vagy **Visszavonom**
   (ez visszaállítja az eredeti értékeket).
5. Mentés a megszokott **Mentés** gombbal.

Ha az AI egy másik változatot is javasol (pl. PowerShell egy bash parancshoz), egy külön kártyán jelenik meg:
**Fül hozzáadása**. Ha egyik kategóriád sem illik, új kategória nevét javasolhatja: **Létrehozom**.

## Könyvjelző kitöltése

1. Könyvjelzők fül → **Új könyvjelző hozzáadása** (vagy egy könyvjelző **Szerkesztés** ablaka).
2. Írd vagy másold be az **URL**-t.
3. Kattints az **✨ AI kitöltés** gombra (vagy `Ctrl`+`Enter`). Az AI megnézi az oldal címét és leírását, és javasol
   címet (az oldal nyelvén, a márkanévvel), leírást, címkéket és kategóriát.
4. **Elfogadom** vagy **Visszavonom**, majd **Mentés**. Ha új kategóriát javasol, a **Létrehozom** gombbal hozod létre.

## Feladatok

- **Gyors felvétel kötetlen mondatból:** írd be a felső mezőbe, amit kell csinálni, pl. „jövő kedden fel kéne hívni a
  könyvelőt a számlák miatt, fontos”, és kattints a sor végi **✨** gombra (vagy `Ctrl`+`Enter`). Alatta megjelenik a
  javaslat („AI” jellel): cím, határidő, prioritás, címkék, projekt. **Enter**rel mented, az **Elvetem** vagy a szöveg
  átírása eltünteti. A megszokott `holnap 9`, `!1`, `#címke` írásmód AI nélkül is működik.
- **Címkék, projekt, prioritás:** nyisd meg a feladatot, és kattints az **✨ AI: címkék, projekt** gombra. A
  javaslatkártyán pipáld ki, ami kell, majd **Elfogadom**.
- **Bontás lépésekre:** a részletes panel Részfeladatok részénél a **Bontsd lépésekre** 3–7 lépést javasol. A kipipáltakból
  a **Részfeladatok létrehozása** gomb részfeladatot készít.

## Jegyzetek

A jegyzetszerkesztő alsó sávjában a **✨** gomb menüje:

- **Cím, címkék, kategória:** javaslatkártya pipákkal; új kategóriát is javasolhat (ezt alapból nem pipálja be).
- **Összefoglaló:** 2–4 mondatos összefoglaló, a **Beszúrás az elejére** gombbal kerül a jegyzet elejére. Listás jegyzetnél nem érhető el.
- **Teendők kiszedése:** a jegyzetből feladatokat javasol; a kipipáltakat a **Feladatok létrehozása** gomb felveszi a
  Feladatok közé, a jegyzethez kapcsolva. Új jegyzetnél az első mentés után érhető el.

Az AI a jegyzet szövegét nem írja át. Első használatkor a CloudMark figyelmeztet, hogy a jegyzet szövege elmegy az AI
szolgáltatóhoz: jelszót, tokent ne küldj vele.

## Tippek

- Alapból csak az üres mezőket tölti ki. A **Mindent újraír** jelölővel a kitöltött mezőket is újraírja (a bemásolt kódot ekkor sem).
- Kategóriát csak a meglévők közül választ, a címkéknél a már használt címkéidet részesíti előnyben.
- Egy meglévő kódrészlet szerkesztésekor is működik.

## Gyakori kérdések

- **Mit kap meg az AI?** Csak az adott űrlap mezőit (könyvjelzőnél az oldal címét és leírását is), az adott nézet kategóriáinak vagy projektjeinek és a címkéidnek a nevét. Más elemeidet nem.
- **Hol van a kulcsom?** A szerveren titkosítva. A böngésző soha nem kapja vissza, a Beállításokban csak az utolsó 4 karaktere látszik.
- **A Gemini ingyenes kulcsa biztonságos?** Az ingyenes szinten a Google a beküldött szöveget felhasználhatja a
  termékei fejlesztésére, ezért titkot (jelszót, tokent) ne írj a mezőkbe vagy a jegyzetbe, amikor az AI-t használod.
- **„Elfogyott a korlát” hibát kapok.** Az ingyenes szinten percenkénti és napi korlát van; várj egy kicsit.
  A CloudMark is korlátozza: legfeljebb 10 AI kérés percenként.
