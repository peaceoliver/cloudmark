# AI kitöltés saját kulccsal

A saját AI kulcsoddal (Gemini, Claude vagy egy OpenAI-kompatibilis szolgáltató) az **✨ AI kitöltés** gomb
kitölti az Új parancs űrlap mezőit. Az AI csak a gomb megnyomására fut, és semmit nem ment el magától.

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

## Új parancs kitöltése

1. Parancsok fül → **Új parancs hozzáadása**.
2. Két lehetőség:
   - **Bemásolod a parancsot** a Kód mezőbe → az AI kitölti a címet, a leírást, a címkéket, a kategóriát és a nyelvet.
     A bemásolt kódot nem írja át.
   - **A címbe vagy a leírásba írod, mit szeretnél** (pl. „állítsd le az összes docker konténert”) → az AI megírja a
     parancsot, kitölti a többi mezőt, és a címet, leírást rendes szövegre javítja.
3. Kattints az **✨ AI kitöltés** gombra (vagy nyomd meg a `Ctrl`+`Enter` billentyűt az űrlapon).
4. A javasolt értékek kiemelve jelennek meg. Nézd át, írd át, ha kell, majd **Elfogadom** vagy **Visszavonom**
   (ez visszaállítja az eredeti értékeket).
5. Mentés a megszokott **Mentés** gombbal.

Ha az AI egy másik változatot is javasol (pl. PowerShell egy bash parancshoz), egy külön kártyán jelenik meg:
**Fül hozzáadása**. Ha egyik kategóriád sem illik, új kategória nevét javasolhatja: **Létrehozom**.

## Tippek

- Alapból csak az üres mezőket tölti ki. A **Mindent újraír** jelölővel a kitöltött mezőket is újraírja (a bemásolt kódot ekkor sem).
- Kategóriát csak a meglévők közül választ, a címkéknél a már használt címkéidet részesíti előnyben.
- Egy meglévő parancs szerkesztésekor is működik.

## Gyakori kérdések

- **Mit kap meg az AI?** Csak az űrlap mezőit, a parancs-kategóriáid és a címkéid nevét. Más elemeidet nem.
- **Hol van a kulcsom?** A szerveren titkosítva. A böngésző soha nem kapja vissza, a Beállításokban csak az utolsó 4 karaktere látszik.
- **A Gemini ingyenes kulcsa biztonságos?** Az ingyenes szinten a Google a beküldött szöveget felhasználhatja a
  termékei fejlesztésére, ezért titkot (jelszót, tokent) ne írj a mezőkbe, amikor az AI-t használod.
- **„Elfogyott a korlát” hibát kapok.** Az ingyenes szinten percenkénti és napi korlát van; várj egy kicsit.
  A CloudMark is korlátozza: legfeljebb 10 AI kérés percenként.
