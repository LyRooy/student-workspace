# Student Workspace — Plan zajęć + Tablica Kanban

**Student Workspace** (wcześniej *academic-calendar*) to lekka, responsywna aplikacja SPA dla studentów, łącząca interaktywny **Plan zajęć** oraz **Tablicę Kanban** z synchronizacją w chmurze bez tradycyjnych baz danych SQL i bez skomplikowanych kont użytkowników.

- **Frontend**: Czysty HTML5, CSS3 i nowoczesny vanilla JavaScript (ES modules) z zestawem ikon Phosphor Icons.
- **Backend**: JavaScript działający bezserwerowo jako Cloudflare Worker.
- **Magazyn danych**: Prywatne obiekty JSON w Cloudflare R2 (`plan.json` oraz `kanban.json` z obsługą własnych nazw plików).

---

## Główne moduły aplikacji

Aplikacja działa w trybie **Single Page Application (SPA)** z szybkim przełączaniem zakładek w nagłówku oraz zintegrowanym przełącznikiem **Trybu edycji**, który chroni przed przypadkowymi zmianami w widoku przeglądania.

### 1. Plan zajęć

- **Responsywny widok tygodnia**:
  - **Komputer**: Siatka godzinowa w odstępach 5-minutowych (z liniami pomocniczymi co kwadrans i pełną godzinę) oraz kolumnami dni poniedziałek–niedziela.
  - **Telefon**: Układ pojedynczego dnia w stylu USOS z górnym paskiem szybkiego wyboru dnia, obsługą gestów przesuwania palcem (swipe) z płynną animacją przejścia oraz blokadą przewijania tła przy otwartych oknach dialogowych.
- **Zajęcia i przedmioty**:
  - Każde spotkanie ma przypisany przedmiot, salę, prowadzącego, tryb (stacjonarny / zdalny) oraz bogate notatki.
  - Typy zajęć: Wykład, Ćwiczenia, Laboratorium, Projekt, Seminarium, Konsultacje, Inne.
  - Dodawanie jednorazowe, co tydzień, co dwa tygodnie (z uwzględnieniem parzystości tygodni) lub na wskazane daty.
  - Masowa edycja i usuwanie pojedynczych spotkań lub całych serii.
  - Ostrzeżenia o nakładających się terminach.
- **Sesja egzaminacyjna**:
  - Dedykowane wsparcie dla okresów sesji ze specjalną fioletową stylistyką.
  - Specjalne typy wydarzeń: *Egzamin*, *Egzamin poprawkowy*, *Kolokwium / Zaliczenie*, *Obrona*.
- **Struktura roku akademickiego**:
  - Definiowanie świąt, dni wolnych, godzin rektorskich oraz dni z zamianą planu (np. środa realizowana według planu piątkowego).
  - Płynne przewijanie (animacja marquee / ping-pong) długich nazw dni specjalnych w nagłówkach kolumn bez zmniejszania czytelności czcionki.
- **Wskaźnik czasu na żywo**:
  - Stały zegar na żywo z pulsującym indykatorem w górnym pasku aplikacji.
  - Czerwony pasek aktualnej godziny na siatce, który przesuwa się co minutę i automatycznie znika, gdy wszystkie dzisiejsze zajęcia dobiegną końca.
  - Wyrazista, gradientowa plakietka **„KONIEC NA DZIŚ”** pojawiająca się pod nagłówkiem dnia po zakończeniu ostatnich zajęć.
- **Wizualizacja okienek**:
  - Czytelne wyróżnienie przerw między zajęciami za pomocą ukośnych pasków w motywie jasnym i ciemnym oraz licznik łącznego czasu okienek w podsumowaniu tygodnia.
- **Inteligentne notatki**:
  - Automatyczne wykrywanie linków URL w opisach i notatkach (klikalne chipy z przyciskiem szybkiego kopiowania) oraz swobodne zaznaczanie tekstu bez kolizji z przeciąganiem.

---

### 2. Tablica Kanban

- **Organizacja zadań**:
  - 3 kolumny statusu: **Do zrobienia**, **W toku** oraz **Zrobione**.
  - Dynamiczny licznik otwartych zadań w plakietce zakładki Kanban.
- **Zadania studenckie**:
  - Tytuł zadania, powiązanie z przedmiotem z planu zajęć, termin wykonania (deadline), priorytet (*Niski*, *Średni*, *Wysoki*) oraz pole notatek.
  - Wzbogacony podgląd notatek z klikalnymi linkami i wygodnym kopiowaniem odnośników.
- **Wygodna obsługa**:
  - Płynne przeciąganie kart między kolumnami (**Drag & Drop**) na komputerze oraz dedykowane przyciski szybkiej zmiany statusu na telefonie.
- **Tryb edycji w Kanbanie**:
  - Gdy tryb edycji jest wyłączony, kliknięcie w kartę otwiera estetyczny modal podglądu szczegółów (z możliwością łatwego kopiowania i klikania linków).
  - W trybie edycji dostępne jest pełne dodawanie, modyfikowanie, przeciąganie i usuwanie zadań.
- **Niezależny plik i pamięć**:
  - Osobny klucz w `localStorage` (`student-kanban-v1`).
  - Osobny plik `.json` w chmurze R2 (domyślnie `kanban.json` z opcją zdefiniowania własnej nazwy w oknie dialogowym Chmury).
  - Dedykowany eksport i import plików JSON niezależny od planu zajęć.

---

## Architektura i synchronizacja

- **Brak tradycyjnych kont**: Autoryzacja oparta o wspólny klucz dostępu (`PLAN_TOKEN`) przechowywany lokalnie w przeglądarce.
- **Dwa niezależne zasoby chmurowe**:
  - Plan zajęć: endpoint `/api/plan` (domyślnie obiekt `plan.json` lub podany w nagłówku `X-Plan-Id`).
  - Tablica Kanban: endpoint `/api/kanban` (domyślnie obiekt `kanban.json` lub podany w nagłówku `X-Kanban-Id`).
- **Atomowy zapis i ochrona przed konfliktami**:
  - Nagłówki `ETag` i `If-Match` gwarantują, że starsza kopia z innego urządzenia nie nadpisze nowszych zmian.
  - Wykrywanie równoczesnej pracy w kilku kartach tej samej przeglądarki przez `BroadcastChannel` i natychmiastowe zabezpieczenie przed desynchronizacją.
- **Motyw graficzny**:
  - Obsługa trybu jasnego, ciemnego i automatycznego (dopasowanego do systemu operacyjnego) bez nieprzyjemnego błysku przy przeładowaniu strony.

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

5. Wejdź na adres produkcyjny aplikacji (`https://student-workspace.<twoja-subdomena>.workers.dev`), kliknij przycisk **Klucz dostępu** w oknie chmury, podaj swój token i pobierz/zapisz dane.

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
