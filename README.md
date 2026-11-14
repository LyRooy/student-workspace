# Student Workspace — Plan zajęć + Tablica Kanban

**Student Workspace** (wcześniej *academic-calendar*) to lekka, responsywna aplikacja SPA dla studentów, łącząca interaktywny **Plan zajęć** oraz **Tablicę Kanban** z synchronizacją w chmurze bez tradycyjnych baz danych SQL i bez skomplikowanych kont użytkowników.

- **Frontend**: Czysty HTML5, CSS3 i nowoczesny vanilla JavaScript (ES modules) z zestawem ikon Phosphor Icons.
- **Backend**: JavaScript działający bezserwerowo jako Cloudflare Worker.
- **Magazyn danych**: Prywatne obiekty JSON w Cloudflare R2 (`plan.json` oraz `kanban.json` z obsługą własnych nazw plików).

---

## Główne moduły i nawigacja aplikacji

Aplikacja działa w trybie **Single Page Application (SPA)** z wyśrodkowanym na desktopie przełącznikiem widoku w nagłówku (`Plan zajęć` / `Tablica Kanban`), plakietką statusu chmury na żywo, przełącznikiem motywu (`Auto` / jasny / ciemny) oraz globalnym przyciskiem **Tryb edycji**.

Pasek narzędzi pod nagłówkiem (na telefonie rozwijany przyciskiem **Menu**) grupuje opcje w czytelne kategorie:
- **Po lewej**: `Przedmioty`, rozwijane menu `Dane (.json)` (`Eksport (.json)`, `Import (.json)`), a po włączeniu `Tryb edycji` także główny przycisk dodawania (`Dodaj zajęcia` lub `Dodaj zadanie`) oraz menu `Zarządzaj planem` / `Zarządzaj tablicą`.
- **Po prawej**: rozwijane menu `Chmura` (`Zapisz w chmurze`, `Pobierz z chmury`, `Ustawienia chmury`).

### 1. Plan zajęć

- **Responsywny widok tygodnia**:
  - **Komputer**: Siatka godzinowa w odstępach 5-minutowych (z liniami pomocniczymi co kwadrans i pełną godzinę) oraz kolumnami dni poniedziałek–niedziela.
  - **Telefon**: Układ pojedynczego dnia w stylu USOS z górnym paskiem szybkiego wyboru dnia, obsługą gestów przesuwania palcem (swipe) z płynną animacją przejścia oraz blokadą przewijania tła przy otwartych oknach dialogowych.
- **Zajęcia i przedmioty**:
  - Każde spotkanie ma przypisany przedmiot (lub własną nazwę poza przedmiotem), salę, prowadzącego, tryb (stacjonarny / zdalny) oraz notatki.
  - Rozbudowane typy zajęć (m.in. Wykład, Ćwiczenia, Laboratorium, Projekt, Seminarium, Konsultacje, Egzamin, Poprawka, Kolokwium, Obrona, Odrabianie zajęć, Spotkanie oraz typy własne).
  - Dodawanie jednorazowe, co tydzień, co dwa tygodnie (z uwzględnieniem parzystości tygodni) lub na wskazane daty.
  - Masowa edycja, dopasowanie do roku akademickiego oraz usuwanie pojedynczych spotkań lub całych serii (`Zarządzaj planem → Masowe usuwanie / reset`).
  - Ostrzeżenia o nakładających się terminach.
- **Sesja egzaminacyjna**:
  - Dedykowane wsparcie dla okresów sesji ze specjalną fioletową stylistyką.
  - Specjalne typy wydarzeń: *Egzamin*, *Egzamin poprawkowy*, *Kolokwium / Zaliczenie*, *Obrona*.
- **Struktura roku akademickiego** (`Zarządzaj planem → Struktura roku`):
  - Definiowanie świąt, dni wolnych, godzin/dni rektorskich oraz dni z zamianą planu (np. środa realizowana według planu piątkowego).
  - Płynne przewijanie (animacja marquee) długich nazw dni specjalnych w nagłówkach kolumn bez zmniejszania czytelności czcionki.
- **Wskaźnik czasu na żywo**:
  - Pływający zegar z datą w prawym dolnym rogu ekranu (kliknięcie przewija do dzisiejszego dnia w planie zajęć).
  - Czerwony pasek aktualnej godziny na siatce, który przesuwa się automatycznie i znika, gdy wszystkie dzisiejsze zajęcia dobiegną końca.
  - Plakietka **„Koniec na dziś”** pojawiająca się pod nagłówkiem dnia po zakończeniu ostatnich zajęć.
- **Wizualizacja okienek**:
  - Czytelne wyróżnienie przerw między zajęciami za pomocą ukośnych pasków w motywie jasnym i ciemnym oraz licznik łącznego czasu okienek w podsumowaniu tygodnia.
- **Inteligentne notatki**:
  - Automatyczne wykrywanie linków URL w opisach i notatkach (klikalne chipy z przyciskiem szybkiego kopiowania) oraz swobodne zaznaczanie tekstu.

---

### 2. Tablica Kanban

- **Konfigurowalne kolumny**:
  - Domyślnie 3 kolumny (**Do zrobienia**, **W toku**, **Zrobione**) z możliwością dodawania do 12 własnych kolumn, zmiany ich nazw, kolejności i usuwania pustych kolumn (`Zarządzaj tablicą → Kolumny`).
  - Dynamiczny licznik otwartych zadań w plakietce zakładki `Tablica Kanban`, filtrowanie po przedmiocie/priorytecie i wyszukiwarka tekstowa.
  - Na telefonie pasek zakładek kolumn oraz przełączanie kolumn gestem swipe.
- **Zadania studenckie**:
  - Tytuł zadania, powiązanie z przedmiotem z planu zajęć (lub własny projekt), kategoria, termin wykonania (deadline z ostrzeżeniami o zbliżającym się lub przekroczonym terminie), priorytet (*Niski*, *Średni*, *Wysoki*), opis/notatki oraz **lista podzadań (checklista)** z paskiem postępu.
  - Wzbogacony podgląd notatek z klikalnymi linkami i wygodnym kopiowaniem treści.
- **Wygodna obsługa zawsze pod ręką**:
  - Przeciąganie kart między kolumnami (**Drag & Drop**), szybkie przenoszenie przyciskami strzałek oraz **odhaczanie podzadań na checklistach działają zawsze** — również przy wyłączonym `Tryb edycji`.
- **Tryb edycji w Kanbanie**:
  - Gdy `Tryb edycji` jest wyłączony, kliknięcie w kartę otwiera modal podglądu szczegółów (z kopiowaniem i odhaczaniem checklisty) bez ryzyka przypadkowej edycji treści czy usunięcia zadania.
  - Włączenie `Tryb edycji` odblokowuje dodawanie nowych kart (`Dodaj zadanie` oraz przyciski `+` w kolumnach), edycję i usuwanie zadań oraz menu `Zarządzaj tablicą` (`Kolumny`, `Wyczyść „Zrobione”`, `Resetuj tablicę`).
- **Niezależny plik i pamięć**:
  - Osobny klucz w `localStorage` (`student-kanban-v1`).
  - Osobny plik `.json` w chmurze R2 (domyślnie `kanban.json`, opcjonalnie `kanban/<id>.json` ustawiane w `Ustawieniach chmury`).
  - Dedykowany eksport i import plików JSON niezależny od planu zajęć.

---

## Architektura i synchronizacja

- **Brak tradycyjnych kont**: Autoryzacja oparta o wspólny klucz dostępu (`PLAN_TOKEN`) przechowywany lokalnie w przeglądarce i weryfikowany w stałym czasie (SHA-256).
- **Dwa niezależne zasoby chmurowe**:
  - Plan zajęć: endpoint `/api/plan` (opcjonalny parametr `?id=<nazwa>` → `plans/<id>.json`, domyślnie `plan.json`).
  - Tablica Kanban: endpoint `/api/kanban` (opcjonalny parametr `?id=<nazwa>` → `kanban/<id>.json`, domyślnie `kanban.json`).
- **Automatyczna synchronizacja na żywo (Auto-sync)**:
  - **Auto-zapis**: Lokalne zmiany są automatycznie wysyłane do chmury po krótkim opóźnieniu (~1,2 s) oraz awaryjnie przy ukrywaniu lub zamykaniu karty (`visibilitychange`, `pagehide`, `beforeunload` z `keepalive: true`).
  - **Odświeżanie na żywo**: Widoczna karta automatycznie sprawdza chmurę co **5 s** (oraz przy powrocie do karty/okna `visibilitychange`, `focus`, `online`) za pomocą lekkiego warunkowego zapytania `GET` z nagłówkiem `If-None-Match` — bez pobierania całego pliku JSON, jeśli dane nie uległy zmianie.
  - Auto-synchronizację można włączyć lub wyłączyć w oknie `Chmura → Ustawienia chmury`.
- **Atomowy zapis i ochrona przed konfliktami**:
  - Nagłówki `ETag`, `If-Match` i `If-None-Match` gwarantują, że starsza kopia z innego urządzenia nie nadpisze po cichu nowszych zmian.
  - Wykrywanie zmian z innej karty tej samej przeglądarki przez zdarzenie `storage` i zabezpieczenie przed nadpisaniem.
- **Motyw graficzny**:
  - Obsługa trybu jasnego, ciemnego i automatycznego (dopasowanego do systemu operacyjnego) bez błysku przy przeładowaniu strony.

---

## Uruchomienie lokalne

Wymagany jest **Node.js 22 LTS** lub nowszy.

1. Zainstaluj zależności:
   ```sh
   npm ci
   ```

2. Skopiuj plik ze zmiennymi środowiskowymi:
   ```sh
   cp .dev.vars.example .dev.vars
   ```

3. Wygeneruj bezpieczny klucz dostępu (np. w Node.js):
   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. Wklej wygenerowany klucz do pliku `.dev.vars`:
   ```text
   PLAN_TOKEN="twoj-tajny-klucz-dostepu"
   ```

5. Uruchom serwer deweloperski Cloudflare Wrangler:
   ```sh
   npm run dev
   ```

6. Otwórz w przeglądarce adres zwrócony przez Wrangler (zwykle `http://localhost:8787`).
   > **Uwaga**: Nie otwieraj pliku `index.html` bezpośrednio przez protokół `file://` – moduły ES6 i endpointy API wymagają serwera HTTP.

---

## Wdrożenie produkcyjne (Cloudflare Workers + R2)

Projekt korzysta z **Cloudflare Workers Static Assets**, dzięki czemu statyczny frontend i backend API działają w ramach jednej usługi bez konieczności konfiguracji osobnego projektu Cloudflare Pages.

1. Zaloguj się do Cloudflare:
   ```sh
   npx wrangler login
   ```

2. Utwórz prywatny bucket R2 na dane:
   ```sh
   npx wrangler r2 bucket create student-calendar-plans
   ```
   *(Jeśli wybierzesz inną nazwę, zaktualizuj `bucket_name` w pliku `wrangler.jsonc`)*.

3. Wdróż aplikację:
   ```sh
   npm run deploy
   ```

4. Ustaw produkcyjny sekret `PLAN_TOKEN` w Cloudflare:
   ```sh
   npx wrangler secret put PLAN_TOKEN
   ```
   Wklej ten sam klucz dostępu (o długości 32–200 znaków).

5. Wejdź na adres produkcyjny aplikacji (`https://student-workspace.<twoja-subdomena>.workers.dev`), otwórz **Chmura → Ustawienia chmury** (lub kliknij plakietkę statusu w nagłówku), podaj swój token i pobierz/zapisz dane.

---

## Struktura plików projektu

- `public/index.html` — struktura interfejsu SPA (widok kalendarza, tablica Kanban, modale zadań, zajęć i struktury roku).
- `public/style.css` — style, zmienne motywów jasnego/ciemnego, siatka godzinowa, widok mobilny i animacje.
- `public/app.js` — logika interfejsu SPA, obsługa zdarzeń, Drag & Drop w Kanbanie, obsługa swipe i zegara na żywo.
- `public/model.js` — modele danych, generator terminów, algorytmy okienek, walidacja schematów planu i tablicy Kanban.
- `public/theme.js` — wczesna inicjalizacja motywu zapobiegająca migotaniu tła.
- `worker.js` — backend Cloudflare Worker obsługujący endpointy `/api/plan` oraz `/api/kanban` z warunkowym zapisem w R2.
- `wrangler.jsonc` — konfiguracja Cloudflare Worker, bindingi do bucketa R2 i zasobów statycznych.
- `test/plan.test.js` — zestaw 13 testów jednostkowych weryfikujących model, reguły dat, API i tablicę Kanban.

---

## Testy i weryfikacja jakości

```sh
npm test        # Uruchomienie 13 testów jednostkowych modelu, API i Kanbanu
npm run check   # Testy jednostkowe + próbne zbudowanie Workera (wrangler deploy --dry-run)
```

---

## Prawa autorskie

© 2026 Dawid Łyczko (LyRooy). Wszelkie prawa zastrzeżone.
