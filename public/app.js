// Logika interfejsu: renderowanie tygodnia, tryb przeglądania i edycji,
// formularze, zapis lokalny (localStorage) oraz synchronizacja z Workerem Cloudflare (/api/plan).

import {
  emptyPlan,
  validatePlan,
  datesFor,
  addDays,
  monday,
  holidayFor,
  reconcileWithAcademicYear,
  resolvePlanKey,
  emptyKanban,
  validateKanban,
  resolveKanbanKey,
} from './model.js';

// --- Stałe i stan ------------------------------------------------------------

const STORAGE_KEY = 'student-calendar-v1';
const KANBAN_STORAGE_KEY = 'student-kanban-v1';
const TOKEN_KEY = 'student-calendar-token';
const PLAN_ID_KEY = 'student-calendar-plan-id';
const KANBAN_ID_KEY = 'student-calendar-kanban-id';
const API_URL = '/api/plan'; // ten sam adres co frontend — Worker obsługuje oba
const KANBAN_API_URL = '/api/kanban';
const API_TIMEOUT_MS = 20_000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;
const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Ndz'];
const MOBILE_DAY_CODES = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SB', 'ND'];

function weekdayIndex(date) {
  return (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
}

/** state.plan – dane planu, state.etag – wersja z chmury, state.dirty – niezsynchronizowane zmiany */
let state = { plan: emptyPlan(), etag: null, dirty: false };
let lastStored = null;       // ostatnia wartość zapisana przez tę kartę (wykrywanie innych kart)
/** kanbanState.kanban – osobny obiekt tablicy Kanban zapisywany w osobnym pliku JSON */
let kanbanState = { kanban: emptyKanban(), etag: null, dirty: false };
let lastStoredKanban = null;
let activeView = 'calendar'; // 'calendar' | 'kanban'
let storageBlocked = false;  // localStorage niedostępny lub zmieniony przez inną kartę
let busy = false;            // trwa synchronizacja
let editMode = false;        // false = normalny tryb przeglądania, true = tryb edycji
let editingId = null;        // id edytowanych zajęć (null = nowe)
let detailsEventId = null;   // id zajęć aktualnie wyświetlanych w oknie szczegółów
let editingKanbanCardId = null;
let detailsKanbanCardId = null;
let draftChecklist = [];     // robocza checklista w oknie edycji zadania Kanban
let selectedKanbanColIndex = 0; // aktywna kolumna w widoku mobilnym tablicy Kanban
let kanbanMobileSlideDir = '';
let draggedKanbanCardId = null;
let week = monday(today());  // poniedziałek wyświetlanego tygodnia
let selectedDayIndex = weekdayIndex(today()); // 0..6 — aktywny dzień w widoku mobilnym (jak w USOS)
let mobileSlideDir = '';     // 'slide-next' | 'slide-prev' | '' — kierunek animacji przełączania dnia na telefonie
let currentGridBounds = { startMin: 8 * 60, endMin: 16 * 60 };
let lastRenderedToday = today();
let lockedScrollY = 0;
let isScrollLocked = false;

// --- Narzędzia ---------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

/** Dzisiejsza data lokalna w formacie RRRR-MM-DD. */
function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function nowMinutesFloat() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function nowTimeLabel() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Blokuje przewijanie tła strony, gdy jakiekolwiek okno modalne (<dialog>) jest otwarte. */
function syncModalScrollLock() {
  const anyDialogOpen = Boolean(document.querySelector('dialog[open]'));
  if (anyDialogOpen && !isScrollLocked) {
    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    isScrollLocked = true;
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    document.body.style.top = `-${lockedScrollY}px`;
  } else if (!anyDialogOpen && isScrollLocked) {
    isScrollLocked = false;
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }
}

function showDialogModal(dialogEl) {
  dialogEl.showModal();
  syncModalScrollLock();
}

const uid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const URL_REGEX = /(https?:\/\/[^\s<>"')]+)/gi;

async function copyTextWithFeedback(text, btnEl, defaultLabel = null) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btnEl) {
      const prevHtml = btnEl.innerHTML;
      btnEl.classList.add('copied');
      btnEl.innerHTML = defaultLabel
        ? '<i class="ph ph-check"></i> <span>Skopiowano!</span>'
        : '<i class="ph ph-check"></i>';
      setTimeout(() => {
        btnEl.classList.remove('copied');
        btnEl.innerHTML = prevHtml;
      }, 1500);
    }
  } catch {
    setStatus('Nie udało się automatycznie skopiować do schowka.');
  }
}

/**
 * Renderuje tekst notatki/opisu z automatycznym zamienianiem adresów URL (http/https)
 * na klikalne odnośniki z przyciskiem „Kopiuj link” obok każdego linku.
 */
function renderRichTextWithLinks(container, rawText) {
  container.replaceChildren();
  const text = rawText || '';
  if (!text) return;

  let lastIdx = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0];
    const startIdx = match.index ?? 0;

    if (startIdx > lastIdx) {
      container.append(document.createTextNode(text.slice(lastIdx, startIdx)));
    }

    const chip = node('span', 'rich-link-chip');
    const link = node('a', 'rich-link');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.draggable = false;
    link.innerHTML = '<i class="ph ph-arrow-square-out"></i>';
    link.append(node('span', 'rich-link-url', url));
    link.onclick = (e) => e.stopPropagation();

    const copyBtn = node('button', 'rich-link-copy');
    copyBtn.type = 'button';
    copyBtn.title = 'Kopiuj ten link do schowka';
    copyBtn.setAttribute('aria-label', 'Kopiuj link');
    copyBtn.innerHTML = '<i class="ph ph-copy"></i>';
    copyBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyTextWithFeedback(url, copyBtn);
    };

    chip.append(link, copyBtn);
    container.append(chip);
    lastIdx = startIdx + url.length;
  }

  if (lastIdx < text.length) {
    container.append(document.createTextNode(text.slice(lastIdx)));
  }
}

const dayMonthFormat = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' });
const fullDateFormat = new Intl.DateTimeFormat('pl-PL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const formatDate = (date) => dayMonthFormat.format(new Date(date + 'T12:00:00Z'));
const formatFullDate = (date) => fullDateFormat.format(new Date(date + 'T12:00:00Z'));

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// --- Komunikaty --------------------------------------------------------------

function setStatus(message) {
  $('status').textContent = message;
}

function reportState() {
  if (storageBlocked) {
    setStatus('Nie można bezpiecznie zapisać danych lokalnych. Wyeksportuj plik JSON i sprawdź pamięć przeglądarki.');
    return;
  }
  if (activeView === 'kanban') {
    if (kanbanState.dirty) {
      setStatus(
        'Masz lokalne zmiany w tablicy Kanban · Kliknij „Zapisz tablicę w chmurze”, aby zapisać osobny plik kanban.json w chmurze.',
      );
    } else {
      setStatus(
        'Tablica Kanban zapisana lokalnie (osobny plik kanban.json) · Pobierz z chmury, aby sprawdzić aktualną wersję.',
      );
    }
    return;
  }
  if (state.dirty) {
    setStatus('Masz lokalne zmiany · Kliknij „Zapisz plan w chmurze”, aby nadpisać plan w chmurze i udostępnić go na innych urządzeniach.');
  } else {
    setStatus('Plan zapisany lokalnie · Pobierz z chmury, aby sprawdzić aktualną wersję.');
  }
}

function updateViewToolbarAndHeader() {
  const isKanban = activeView === 'kanban';

  $('tabCalendar').classList.toggle('active', !isKanban);
  $('tabCalendar').setAttribute('aria-selected', String(!isKanban));
  $('tabKanban').classList.toggle('active', isKanban);
  $('tabKanban').setAttribute('aria-selected', String(isKanban));

  $('calendarView').hidden = isKanban;
  $('kanbanView').hidden = !isKanban;

  $('appHeading').innerHTML = isKanban ? 'Tablica Kanban<span>.</span>' : 'Plan zajęć<span>.</span>';

  // Przyciski paska górnego zależne od aktywnej zakładki oraz trybu edycji
  $('editModeToggle').hidden = false;
  $('addEvent').hidden = isKanban || !editMode;
  $('manageKanbanColsBtn').hidden = !isKanban || !editMode;
  $('addKanbanCardBtn').hidden = !isKanban || !editMode;

  // Przyciski w panelu narzędzi (#navPanel)
  $('academicYearBtn').hidden = isKanban || !editMode;
  $('bulkManageBtn').hidden = isKanban || !editMode;
  $('clearKanbanDoneBtn').hidden = !isKanban || !editMode;
  $('resetKanbanBtn').hidden = !isKanban || !editMode;

  $('exportLabel').textContent = isKanban ? 'Eksport tablicy (.json)' : 'Eksport planu (.json)';
  $('importLabel').textContent = isKanban ? 'Import tablicy (.json)' : 'Import planu (.json)';
  $('pullLabel').textContent = isKanban ? 'Pobierz tablicę z chmury' : 'Pobierz plan z chmury';
  $('pushLabel').textContent = isKanban ? 'Zapisz tablicę w chmurze' : 'Zapisz plan w chmurze';
  updateConnectionButtonLabel();
}

function setActiveView(view) {
  activeView = view === 'kanban' ? 'kanban' : 'calendar';
  updateViewToolbarAndHeader();
  if (activeView === 'kanban') {
    renderKanban();
  } else {
    render();
  }
  reportState();
}

// --- Tryb przeglądania vs. Tryb edycji ---------------------------------------

function setEditMode(enabled) {
  editMode = !!enabled;
  const toggle = $('editModeToggle');
  toggle.setAttribute('aria-pressed', String(editMode));
  toggle.innerHTML = editMode
    ? '<i class="ph ph-pencil-simple-line"></i> <span class="btn-label">Tryb edycji: Wł.</span>'
    : '<i class="ph ph-pencil-simple"></i> <span class="btn-label">Tryb edycji: Wył.</span>';

  updateViewToolbarAndHeader();
  $('calendarHint').textContent = editMode
    ? 'Tryb edycji aktywny: kliknij nagłówek dnia lub pusty dzień (poza dniami wolnymi), aby dodać zajęcia. Kliknij istniejące zajęcia, aby je edytować lub usunąć.'
    : 'Kliknij zajęcia, aby zobaczyć szczegóły przedmiotu i spotkania. Włącz „Tryb edycji” u góry, aby dodawać lub zmieniać zajęcia oraz edytować strukturę roku.';

  $('kanbanHint').innerHTML = editMode
    ? 'Tryb edycji aktywny: przeciągaj karty między kolumnami (drag &amp; drop), odhaczaj podzadania lub kliknij kartę, aby ją edytować. Tablica zapisuje się w osobnym pliku <code>kanban.json</code>.'
    : 'Kliknij zadanie, aby zobaczyć jego szczegóły. Włącz „Tryb edycji” u góry, aby dodawać zadania, zmieniać kolumny i przesuwać karty na tablicy Kanban.';

  render();
  renderKanban();
}

function setMobileMenuOpen(open) {
  const panel = $('navPanel');
  const btn = $('menuToggle');
  const isOpen = !!open;
  panel.classList.toggle('open', isOpen);
  btn.setAttribute('aria-expanded', String(isOpen));
  btn.innerHTML = isOpen
    ? '<i class="ph ph-x"></i><span>Zamknij</span>'
    : '<i class="ph ph-list"></i><span>Menu</span>';
}

// --- Zapis lokalny -----------------------------------------------------------

function loadFromStorage() {
  try {
    lastStored = localStorage.getItem(STORAGE_KEY);
    if (lastStored) {
      const saved = JSON.parse(lastStored);
      validatePlan(saved.plan);
      state = { plan: saved.plan, etag: saved.etag ?? null, dirty: !!saved.dirty };
    }
    lastStoredKanban = localStorage.getItem(KANBAN_STORAGE_KEY);
    if (lastStoredKanban) {
      const savedKanban = JSON.parse(lastStoredKanban);
      validateKanban(savedKanban.kanban);
      kanbanState = {
        kanban: savedKanban.kanban,
        etag: savedKanban.etag ?? null,
        dirty: !!savedKanban.dirty,
      };
    }
  } catch {
    // Brak dostępu do localStorage lub uszkodzony wpis — blokujemy zapis, żeby niczego nie nadpisać.
    storageBlocked = true;
  }
}

function persist(next) {
  if (storageBlocked) {
    throw Error('Zapis lokalny jest zablokowany. Wyeksportuj plan przed przeładowaniem strony.');
  }
  if (localStorage.getItem(STORAGE_KEY) !== lastStored) {
    throw Error('Inna karta zmieniła plan. Wyeksportuj swoją kopię i odśwież stronę.');
  }

  const encoded = JSON.stringify(next);
  localStorage.setItem(STORAGE_KEY, encoded);
  lastStored = encoded;
  state = next;
}

function persistKanban(next) {
  if (storageBlocked) {
    throw Error('Zapis lokalny jest zablokowany. Wyeksportuj tablicę Kanban przed przeładowaniem strony.');
  }
  if (localStorage.getItem(KANBAN_STORAGE_KEY) !== lastStoredKanban) {
    throw Error('Inna karta zmieniła tablicę Kanban. Wyeksportuj swoją kopię i odśwież stronę.');
  }

  const encoded = JSON.stringify(next);
  localStorage.setItem(KANBAN_STORAGE_KEY, encoded);
  lastStoredKanban = encoded;
  kanbanState = next;
}

/** Wykonuje zmianę na kopii planu, waliduje ją, zapisuje lokalnie i odświeża widok. */
function mutate(change) {
  if (busy) throw Error('Poczekaj na zakończenie synchronizacji.');

  const next = clone(state);
  change(next.plan);
  validatePlan(next.plan);
  next.dirty = true;

  persist(next);
  render();
  renderKanbanBadge();
  if (activeView === 'kanban') renderKanban();
  reportState();
}

/** Wykonuje zmianę na kopii tablicy Kanban, waliduje ją, zapisuje lokalnie i odświeża widok. */
function mutateKanban(change) {
  if (busy) throw Error('Poczekaj na zakończenie synchronizacji.');

  const next = clone(kanbanState);
  change(next.kanban);
  validateKanban(next.kanban);
  next.dirty = true;

  persistKanban(next);
  renderKanban();
  reportState();
}

// Mapowanie dni tygodnia na klucze
const DAY_KEY_NAMES = {
  mon: 'poniedziałku',
  tue: 'wtorku',
  wed: 'środy',
  thu: 'czwartku',
  fri: 'piątku',
  sat: 'soboty',
  sun: 'niedzieli',
};

// --- Widok tygodnia (oś godzin co 5 min, zajęcia proporcjonalne i okienka) ---

const SLOT_MINUTES = 5;
const SLOT_HEIGHT_PX = 15; // 5 min = 15px → 15 min = 45px, 45 min = 135px, 60 min = 180px
const DEFAULT_START_MIN = 8 * 60; // 08:00
const DEFAULT_END_MIN = 16 * 60;  // 16:00

function fromMinutes(total) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} godz. ${m} min`;
  if (h > 0) return `${h} godz.`;
  return `${m} min`;
}

/** Wyznacza zakres godzin siatki tygodnia (zaokrąglony do pełnych godzin). */
function getGridBounds(weekEvents, specialDaysInWeek = []) {
  let startMin = DEFAULT_START_MIN;
  let endMin = DEFAULT_END_MIN;

  for (const e of weekEvents) {
    const s = toMinutes(e.start);
    const end = toMinutes(e.end);
    if (s < startMin) startMin = Math.floor(s / 60) * 60;
    if (end > endMin) endMin = Math.ceil(end / 60) * 60;
  }

  for (const sd of specialDaysInWeek) {
    if (sd?.type === 'rector' && sd.start && sd.end) {
      const s = toMinutes(sd.start);
      const end = toMinutes(sd.end);
      if (s < startMin) startMin = Math.floor(s / 60) * 60;
      if (end > endMin) endMin = Math.ceil(end / 60) * 60;
    }
  }

  return { startMin, endMin };
}

/** Sprawdza, czy dane zajęcia wypadają w trakcie godzin/dnia rektorskiego. */
function isEventCancelledByRector(event, specialDay) {
  if (specialDay?.type !== 'rector') return false;
  if (!event.subjectId) return false; // Wydarzenia własne (np. dentysta) nie przepadają
  if (!specialDay.start || !specialDay.end) return true;
  return (
    toMinutes(event.start) < toMinutes(specialDay.end) &&
    toMinutes(event.end) > toMinutes(specialDay.start)
  );
}

/** Oblicza wpływ godzin/dnia rektorskiego na plan dnia oraz ile czasu jest wolnego. */
function describeRectorImpact(dayEvents, specialDay) {
  const isFullDayRector = !specialDay.start || !specialDay.end;
  const classEvents = dayEvents.filter((e) => Boolean(e.subjectId));
  const cancelled = classEvents.filter((e) => isEventCancelledByRector(e, specialDay));
  const active = classEvents.filter((e) => !isEventCancelledByRector(e, specialDay));

  if (isFullDayRector) {
    return {
      fullDayFree: true,
      cancelledCount: cancelled.length,
      title: 'Wolny dzień · Dzień rektorski',
      hoursLabel: 'Cały dzień',
      freeSummary: cancelled.length
        ? `Wszystkie zajęcia (${cancelled.length}) odwołane — cały dzień wolny`
        : 'Cały dzień wolny od zajęć',
    };
  }

  const rStart = toMinutes(specialDay.start);
  const rEnd = toMinutes(specialDay.end);
  const hoursLabel = `${specialDay.start} – ${specialDay.end} (${formatDuration(rEnd - rStart)})`;

  if (classEvents.length > 0 && active.length === 0) {
    return {
      fullDayFree: true,
      cancelledCount: cancelled.length,
      title: 'Wolny dzień · Godziny rektorskie',
      hoursLabel,
      freeSummary: `Wszystkie zajęcia w tym dniu (${cancelled.length}) przepadają — wolny dzień`,
    };
  }

  const before = active.filter((e) => toMinutes(e.end) <= rStart);
  const after = active.filter((e) => toMinutes(e.start) >= rEnd);

  let freeSummary = '';
  if (before.length > 0 && after.length > 0) {
    const freeFrom = Math.max(...before.map((e) => toMinutes(e.end)));
    const freeUntil = Math.min(...after.map((e) => toMinutes(e.start)));
    const freeMin = Math.max(0, freeUntil - freeFrom);
    freeSummary = `Wolne między zajęciami: ${formatDuration(freeMin)} (${fromMinutes(freeFrom)} – ${fromMinutes(freeUntil)})`;
  } else if (before.length > 0 && after.length === 0) {
    const freeFrom = Math.max(...before.map((e) => toMinutes(e.end)));
    freeSummary = cancelled.length
      ? `Końcowe zajęcia przepadają — wolne od ${fromMinutes(freeFrom)} do końca dnia`
      : `Wolne od ${fromMinutes(freeFrom)} do końca dnia`;
  } else if (before.length === 0 && after.length > 0) {
    const freeUntil = Math.min(...after.map((e) => toMinutes(e.start)));
    freeSummary = cancelled.length
      ? `Poranne zajęcia przepadają — wolne do ${fromMinutes(freeUntil)}`
      : `Wolny poranek — zajęcia od ${fromMinutes(freeUntil)}`;
  } else {
    freeSummary = `Wolne: ${formatDuration(rEnd - rStart)} (${specialDay.start} – ${specialDay.end})`;
  }

  return {
    fullDayFree: false,
    cancelledCount: cancelled.length,
    title: 'Godziny rektorskie',
    hoursLabel,
    freeSummary,
  };
}

/** Wylicza okienka (wolne przerwy) pomiędzy zajęciami w danym dniu. */
function computeGaps(dayEvents) {
  if (dayEvents.length < 2) return [];

  const intervals = dayEvents
    .map((e) => ({ start: toMinutes(e.start), end: toMinutes(e.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = intervals[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i].end;
    const gapEnd = merged[i + 1].start;
    const durationMin = gapEnd - gapStart;
    if (durationMin > 0) {
      gaps.push({ startMin: gapStart, endMin: gapEnd, durationMin });
    }
  }
  return gaps;
}

/** Rozkłada nakładające się zajęcia w kolumny obok siebie. */
function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(b.end) - toMinutes(a.end),
  );
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    const s = toMinutes(ev.start);
    const e = toMinutes(ev.end);
    if (currentCluster.length && s >= clusterEnd) {
      clusters.push(currentCluster);
      currentCluster = [];
      clusterEnd = -1;
    }
    currentCluster.push(ev);
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (currentCluster.length) clusters.push(currentCluster);

  const result = new Map();
  for (const cluster of clusters) {
    const colEnds = [];
    const placement = [];
    for (const ev of cluster) {
      const s = toMinutes(ev.start);
      const e = toMinutes(ev.end);
      let col = colEnds.findIndex((end) => end <= s);
      if (col < 0) {
        col = colEnds.length;
        colEnds.push(e);
      } else {
        colEnds[col] = e;
      }
      placement.push({ ev, col });
    }
    const totalCols = colEnds.length;
    for (const { ev, col } of placement) {
      result.set(ev.id, { col, totalCols, overlaps: totalCols > 1 });
    }
  }
  return result;
}

function renderTimeColumn(gridStartMin, gridEndMin) {
  const col = node('aside', 'time-col');
  col.setAttribute('aria-hidden', 'true');

  const head = node('div', 'time-head');
  head.innerHTML = '<i class="ph ph-clock"></i><span>Godz.</span>';
  col.append(head);

  const totalSlots = (gridEndMin - gridStartMin) / SLOT_MINUTES;
  const slots = node('div', 'time-slots');
  slots.style.height = `${totalSlots * SLOT_HEIGHT_PX}px`;

  let slotIndex = 0;
  for (let m = gridStartMin; m < gridEndMin; m += SLOT_MINUTES, slotIndex++) {
    const isFullHour = m % 60 === 0;
    const isQuarter = m % 15 === 0;
    const label = isFullHour ? fromMinutes(m) : `:${String(m % 60).padStart(2, '0')}`;
    const slotClass = isFullHour
      ? 'time-slot hour'
      : isQuarter
        ? 'time-slot quarter'
        : 'time-slot five';
    const slotEl = node('div', slotClass, label);
    slotEl.style.top = `${slotIndex * SLOT_HEIGHT_PX}px`;
    slotEl.style.height = `${SLOT_HEIGHT_PX}px`;
    slots.append(slotEl);
  }

  col.append(slots);
  return col;
}

/**
 * Buduje szablon linii 5-minutowych dla kolumny dnia oparty na rzeczywistych
 * obramowaniach CSS (border-top) i identycznych współrzędnych top jak kolumna
 * godzin — dzięki temu przy skalowaniu przeglądarki (np. 90%, 80%, 110%) linie
 * nigdy nie znikają ani nie rozjeżdżają się względem osi godzin i bloków zajęć.
 */
function buildTimelineGridTemplate(gridStartMin, gridEndMin) {
  const grid = node('div', 'timeline-grid');
  grid.setAttribute('aria-hidden', 'true');

  let slotIndex = 0;
  for (let m = gridStartMin; m < gridEndMin; m += SLOT_MINUTES, slotIndex++) {
    const isFullHour = m % 60 === 0;
    const isQuarter = m % 15 === 0;
    const slotClass = isFullHour
      ? 'timeline-slot hour'
      : isQuarter
        ? 'timeline-slot quarter'
        : 'timeline-slot five';
    const row = node('div', slotClass);
    row.style.top = `${slotIndex * SLOT_HEIGHT_PX}px`;
    row.style.height = `${SLOT_HEIGHT_PX}px`;
    grid.append(row);
  }

  return grid;
}

function renderMobileDayTabs(weekEvents, specialDayMap) {
  const nav = $('mobileDayTabs');
  nav.replaceChildren();

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const dayEvs = weekEvents.filter((e) => e.date === date);
    const effectiveSpecial = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const isHoliday = effectiveSpecial?.type === 'holiday';
    const isSession = effectiveSpecial?.type === 'session';

    let cls = 'mobile-day-tab';
    if (i === selectedDayIndex) cls += ' active';
    if (date === today()) cls += ' is-today';
    if (isHoliday) cls += ' is-holiday';
    if (isSession) cls += ' is-session';

    const btn = node('button', cls);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(i === selectedDayIndex));

    const code = node('span', 'tab-code', MOBILE_DAY_CODES[i]);
    const num = node('span', 'tab-num', date.slice(8));
    const dot = node('span', dayEvs.length ? 'tab-dot has-events' : 'tab-dot');
    btn.append(code, num, dot);

    btn.onclick = () => {
      if (i !== selectedDayIndex) {
        mobileSlideDir = i > selectedDayIndex ? 'slide-next' : 'slide-prev';
        selectedDayIndex = i;
        render();
      }
    };
    nav.append(btn);
  }
}

function refreshSpecialDayMarquees() {
  for (const outer of document.querySelectorAll('.special-day-label')) {
    const inner = outer.querySelector('.special-day-label-inner');
    if (!inner) continue;
    outer.classList.remove('is-overflowing');
    outer.style.removeProperty('--marquee-shift');
    outer.style.removeProperty('--marquee-time');

    const overflowPx = inner.scrollWidth - outer.clientWidth;
    if (overflowPx > 3) {
      const durationSec = Math.max(5.5, Math.min(14, overflowPx / 12 + 4));
      outer.style.setProperty('--marquee-shift', `-${overflowPx + 6}px`);
      outer.style.setProperty('--marquee-time', `${durationSec.toFixed(1)}s`);
      outer.classList.add('is-overflowing');
    }
  }
}

function updateLiveTimeIndicator() {
  const timeStr = nowTimeLabel();
  const topClock = $('liveClockText');
  if (topClock) topClock.textContent = timeStr;

  const currentToday = today();
  if (currentToday !== lastRenderedToday) {
    lastRenderedToday = currentToday;
    render();
    return;
  }

  const nowMin = nowMinutesFloat();
  const { startMin, endMin } = currentGridBounds;

  for (const line of document.querySelectorAll('[data-now-line]')) {
    const badge = line.querySelector('[data-now-badge]');
    const hasEvents = line.dataset.hasEvents === 'true';
    const lastEndRaw = line.dataset.lastEndMin;
    const lastEndMin = lastEndRaw ? Number(lastEndRaw) : null;
    const allFinished = hasEvents && lastEndMin !== null && nowMin >= lastEndMin;
    const outOfGrid = nowMin < startMin || nowMin >= endMin;

    // Ukrywamy pasek na siatce, gdy zajęcia na dziś już się skończyły, dzień jest pusty lub jesteśmy poza siatką godzin
    if (!hasEvents || allFinished || outOfGrid) {
      line.hidden = true;
    } else {
      line.hidden = false;
      const topPx = ((nowMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX;
      line.style.top = `${topPx}px`;
      if (badge) badge.textContent = `Teraz · ${timeStr}`;
    }

    const daySection = line.closest('.day.today');
    const donePill = daySection?.querySelector('[data-today-done]');
    if (donePill) {
      donePill.hidden = !allFinished;
    }
  }

  for (const evEl of document.querySelectorAll('.day.today .event[data-start-min]')) {
    const evStart = Number(evEl.dataset.startMin);
    const evEnd = Number(evEl.dataset.endMin);
    evEl.classList.toggle('is-now', nowMin >= evStart && nowMin < evEnd);
  }
}

function render() {
  lastRenderedToday = today();
  const weekEnd = addDays(week, 6);
  $('weekTitle').textContent = `${formatDate(week)} – ${formatDate(weekEnd)} ${week.slice(0, 4)}`;
  $('jump').value = addDays(week, selectedDayIndex);

  const events = state.plan.events.filter((e) => e.date >= week && e.date <= weekEnd);
  const minutes = events.reduce((sum, e) => sum + toMinutes(e.end) - toMinutes(e.start), 0);

  const specialDays = state.plan.academicYear?.specialDays || [];
  const specialDayMap = new Map(specialDays.map((sd) => [sd.date, sd]));

  let weekHasSpecialDay = false;
  let totalGapCount = 0;
  let totalGapMinutes = 0;
  const weekSpecialDays = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(week, i);
    const eff = specialDayMap.get(d) || holidayFor(d, state.plan.academicYear);
    if (eff) {
      weekHasSpecialDay = true;
      weekSpecialDays.push(eff);
    }
    const dayEvs = events.filter((e) => e.date === d);
    for (const g of computeGaps(dayEvs)) {
      totalGapCount++;
      totalGapMinutes += g.durationMin;
    }
  }

  const gapSummary =
    totalGapCount > 0 ? ` · Okienka: ${totalGapCount} (${formatDuration(totalGapMinutes)})` : '';
  $('summary').textContent =
    `Liczba spotkań: ${events.length} · Łącznie zajęć: ${formatDuration(minutes)}${gapSummary}`;

  renderMobileDayTabs(events, specialDayMap);

  const { startMin, endMin } = getGridBounds(events, weekSpecialDays);
  currentGridBounds = { startMin, endMin };
  const gridTemplate = buildTimelineGridTemplate(startMin, endMin);

  const calendar = $('calendar');
  calendar.classList.toggle('has-special-days', weekHasSpecialDay);
  calendar.replaceChildren();
  calendar.append(renderTimeColumn(startMin, endMin));

  const slideClass = mobileSlideDir;
  mobileSlideDir = '';

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const effectiveSpecial = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const dayEl = renderDay(date, DAY_NAMES[i], events, effectiveSpecial, startMin, endMin, gridTemplate);
    if (i === selectedDayIndex) {
      dayEl.classList.add('mobile-active');
      if (slideClass) dayEl.classList.add(slideClass);
    }
    calendar.append(dayEl);
  }

  updateLiveTimeIndicator();
  requestAnimationFrame(refreshSpecialDayMarquees);
}

function renderDay(date, dayName, weekEvents, specialDay, gridStartMin, gridEndMin, gridTemplate) {
  const isHoliday = specialDay?.type === 'holiday';
  const isSwap = specialDay?.type === 'swap';
  const isRector = specialDay?.type === 'rector';
  const isSession = specialDay?.type === 'session';
  const isToday = date === today();
  const canAddInDay = editMode;

  let dayClass = 'day';
  if (isToday) dayClass += ' today';
  if (isHoliday) dayClass += ' holiday';
  if (isSession) dayClass += ' session';
  if (isRector) dayClass += ' rector-day';

  const day = node('section', dayClass);

  const topWrap = node('div', 'day-top');
  const head = node('div', canAddInDay ? 'dayhead editable' : 'dayhead');
  const headInfo = node('div', 'dayhead-info');
  headInfo.append(node('span', '', dayName), node('strong', '', date.slice(8)));
  head.append(headInfo);

  if (isToday) {
    const donePill = node('span', 'today-done-pill');
    donePill.setAttribute('data-today-done', '');
    donePill.hidden = true;
    donePill.innerHTML = '<i class="ph ph-check-circle"></i><span>Koniec na dziś</span>';
    head.append(donePill);
  }

  if (canAddInDay) {
    head.title = isHoliday
      ? `Dzień wolny (${date}) — kliknij, aby dodać wydarzenie własne (poza przedmiotem)`
      : isSession
        ? `Sesja egzaminacyjna (${date}) — kliknij, aby dodać egzamin, poprawkę lub zaliczenie`
        : `Kliknij, aby dodać zajęcia w dniu ${date} (${dayName})`;
    head.onclick = () => openEventDialog(null, date);

    const addHint = node('span', 'dayhead-add');
    addHint.innerHTML = '<i class="ph ph-plus"></i>';
    addHint.title = isHoliday
      ? 'Dodaj wydarzenie własne'
      : isSession
        ? 'Dodaj egzamin / zaliczenie'
        : 'Dodaj zajęcia w tym dniu';
    head.append(addHint);
  }

  topWrap.append(head);

  // Oznaczenie dnia specjalnego (święto, weekend, sesja, godziny rektorskie lub plan z innego dnia)
  if (specialDay) {
    const badge = node('div', `special-day-badge ${specialDay.type}`);
    let iconClass = 'ph-sun-horizon';
    let badgeText = '';

    if (isHoliday) {
      iconClass = 'ph-sun-horizon';
      badgeText = specialDay.label || 'Dzień wolny';
    } else if (isSession) {
      iconClass = 'ph-scroll';
      badgeText = specialDay.label || 'Sesja egzaminacyjna';
    } else if (isSwap) {
      iconClass = 'ph-arrows-clockwise';
      const targetName = DAY_KEY_NAMES[specialDay.targetDay] || specialDay.targetDay;
      const labelSuffix = specialDay.label ? ` · ${specialDay.label}` : '';
      badgeText = `Plan z ${targetName}${labelSuffix}`;
    } else if (isRector) {
      iconClass = 'ph-graduation-cap';
      const hoursPart =
        specialDay.start && specialDay.end
          ? `Rektorskie ${specialDay.start}–${specialDay.end}`
          : 'Dzień rektorski';
      const labelSuffix = specialDay.label ? ` · ${specialDay.label}` : '';
      badgeText = `${hoursPart}${labelSuffix}`;
    }

    const iconEl = node('i', `ph ${iconClass}`);
    const labelOuter = node('span', 'special-day-label');
    const labelInner = node('span', 'special-day-label-inner', badgeText);
    labelOuter.append(labelInner);
    badge.append(iconEl, labelOuter);
    badge.title = editMode ? `${badgeText} — kliknij, aby zarządzać strukturą roku` : badgeText;

    if (editMode) {
      badge.classList.add('editable');
      badge.onclick = () => openAcademicYearDialog();
    }
    topWrap.append(badge);
  }

  day.append(topWrap);

  const dayEvents = weekEvents
    .filter((e) => e.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));

  const rectorImpact = isRector ? describeRectorImpact(dayEvents, specialDay) : null;

  const totalSlots = (gridEndMin - gridStartMin) / SLOT_MINUTES;
  let timelineClass = canAddInDay ? 'day-timeline editable' : 'day-timeline';
  if (rectorImpact?.fullDayFree) timelineClass += ' rector-full-free';
  const timeline = node('div', timelineClass);
  timeline.style.height = `${totalSlots * SLOT_HEIGHT_PX}px`;
  if (gridTemplate) {
    timeline.append(gridTemplate.cloneNode(true));
  }

  if (canAddInDay) {
    timeline.title = isHoliday
      ? 'Kliknij w wiersz godziny, aby dodać wydarzenie własne o tej porze'
      : isSession
        ? 'Kliknij w wiersz godziny, aby dodać egzamin lub zaliczenie o tej porze'
        : 'Kliknij w wiersz godziny, aby dodać zajęcia o tej porze';
    timeline.onclick = (e) => {
      if (e.target !== timeline) return;
      const slotIndex = Math.max(0, Math.min(totalSlots - 2, Math.floor(e.offsetY / SLOT_HEIGHT_PX)));
      const clickedMin = gridStartMin + slotIndex * SLOT_MINUTES;
      openEventDialog(null, date, fromMinutes(clickedMin));
    };
  }

  // Renderowanie okienek między zajęciami (z odstępem od sąsiadujących bloków zajęć)
  const GAP_INSET_PX = 3;
  for (const gap of computeGaps(dayEvents)) {
    const topPx = ((gap.startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + GAP_INSET_PX;
    const heightPx = Math.max(
      SLOT_HEIGHT_PX - GAP_INSET_PX * 2,
      (gap.durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - GAP_INSET_PX * 2,
    );
    let gapClass = 'gap-block';
    if (
      isRector &&
      (rectorImpact?.fullDayFree ||
        (specialDay.start &&
          specialDay.end &&
          gap.startMin < toMinutes(specialDay.end) &&
          gap.endMin > toMinutes(specialDay.start)))
    ) {
      gapClass += ' cancelled-by-rector';
    }
    const gapEl = node('div', gapClass);
    gapEl.style.top = `${topPx}px`;
    gapEl.style.height = `${heightPx}px`;

    const title = node('span', 'gap-title');
    title.innerHTML = '<i class="ph ph-hourglass-low"></i> ';
    title.append(document.createTextNode(`Okienko · ${formatDuration(gap.durationMin)}`));
    gapEl.append(title);

    if (gap.durationMin >= 10) {
      gapEl.append(node('span', 'gap-time', `${fromMinutes(gap.startMin)} – ${fromMinutes(gap.endMin)}`));
    }
    timeline.append(gapEl);
  }

  const layoutMap = layoutDayEvents(dayEvents);
  for (const event of dayEvents) {
    timeline.append(renderEvent(event, layoutMap.get(event.id), gridStartMin, specialDay));
  }

  // Pasek aktualnej godziny na żywo (jak w USOS-ie, bez potrzeby odświeżania strony)
  if (isToday) {
    const activeDayEvents = dayEvents.filter((e) => !isEventCancelledByRector(e, specialDay));
    const lastEndMin = activeDayEvents.length
      ? Math.max(...activeDayEvents.map((e) => toMinutes(e.end)))
      : null;

    const nowLine = node('div', 'now-line');
    nowLine.setAttribute('data-now-line', '');
    nowLine.dataset.hasEvents = String(activeDayEvents.length > 0);
    nowLine.dataset.lastEndMin = lastEndMin !== null ? String(lastEndMin) : '';
    nowLine.setAttribute('aria-hidden', 'true');
    const nowDot = node('span', 'now-dot');
    const nowBadge = node('span', 'now-badge');
    nowBadge.setAttribute('data-now-badge', '');
    nowLine.append(nowDot, nowBadge);
    timeline.append(nowLine);
  }

  // Nakładka godzin / dnia rektorskiego
  if (isRector && rectorImpact) {
    const overlay = node(
      'div',
      rectorImpact.fullDayFree ? 'rector-overlay full-day' : 'rector-overlay partial-day',
    );
    if (!rectorImpact.fullDayFree && specialDay.start && specialDay.end) {
      const rStart = Math.max(gridStartMin, toMinutes(specialDay.start));
      const rEnd = Math.min(gridEndMin, toMinutes(specialDay.end));
      const topPx = ((rStart - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX;
      const heightPx = Math.max(SLOT_HEIGHT_PX * 2, ((rEnd - rStart) / SLOT_MINUTES) * SLOT_HEIGHT_PX);
      overlay.style.top = `${topPx}px`;
      overlay.style.height = `${heightPx}px`;
    }

    const card = node('div', 'rector-overlay-card');
    const titleEl = node('div', 'rector-overlay-title');
    titleEl.innerHTML = '<i class="ph ph-graduation-cap"></i> ';
    titleEl.append(document.createTextNode(rectorImpact.title));
    card.append(titleEl);

    const metaText = specialDay.label
      ? `${rectorImpact.hoursLabel} · ${specialDay.label}`
      : rectorImpact.hoursLabel;
    card.append(node('div', 'rector-overlay-meta', metaText));
    card.append(node('div', 'rector-overlay-free', rectorImpact.freeSummary));

    overlay.append(card);
    timeline.append(overlay);
  }

  if (!dayEvents.length && !isRector) {
    if (editMode) {
      const emptyBtn = node('button', 'day-empty-btn');
      emptyBtn.type = 'button';
      emptyBtn.innerHTML = isHoliday
        ? '<i class="ph ph-plus-circle"></i> Dodaj wydarzenie własne'
        : isSession
          ? '<i class="ph ph-plus-circle"></i> Dodaj egzamin / zaliczenie'
          : '<i class="ph ph-plus-circle"></i> Dodaj zajęcia';
      emptyBtn.onclick = () => openEventDialog(null, date);
      timeline.append(emptyBtn);
    } else if (isHoliday) {
      const emptyHoliday = node('div', 'day-empty-overlay');
      emptyHoliday.innerHTML = '<i class="ph ph-sun-horizon"></i> Dzień wolny od zajęć';
      timeline.append(emptyHoliday);
    } else if (isSession) {
      const emptySession = node('div', 'day-empty-overlay session-empty');
      emptySession.innerHTML = '<i class="ph ph-scroll"></i> Sesja egzaminacyjna';
      timeline.append(emptySession);
    } else {
      const emptyNormal = node('div', 'day-empty-overlay', 'Brak zajęć');
      timeline.append(emptyNormal);
    }
  }

  day.append(timeline);
  return day;
}

const CUSTOM_SUBJECT_VALUE = '__custom__';

function getEventDisplay(event) {
  if (event.subjectId) {
    const subject = state.plan.subjects.find((s) => s.id === event.subjectId);
    return {
      title: subject?.name || 'Przedmiot',
      isCustom: false,
      subject: subject || null,
    };
  }
  return {
    title: event.customTitle || 'Wydarzenie',
    isCustom: true,
    subject: null,
  };
}

function getEventTypeVisual(typeStr, isCustom = false) {
  const t = (typeStr || '').toLowerCase();
  if (t.includes('poprawk') || t.includes('komis')) {
    return { variant: 'type-retake', icon: 'ph-arrow-counter-clockwise' };
  }
  if (t.includes('egzamin')) {
    return { variant: 'type-exam', icon: 'ph-scroll' };
  }
  if (t.includes('kolokwium') || t.includes('zaliczeni') || t.includes('wejściów') || t.includes('test')) {
    return { variant: 'type-test', icon: 'ph-check-square-offset' };
  }
  if (t.includes('obrona') || t.includes('dyplom')) {
    return { variant: 'type-defense', icon: 'ph-graduation-cap' };
  }
  if (t.includes('wykład') || t.includes('wyklad')) {
    return { variant: 'type-lecture', icon: 'ph-chalkboard-teacher' };
  }
  if (t.includes('lab')) {
    return { variant: 'type-lab', icon: 'ph-flask' };
  }
  if (t.includes('projekt')) {
    return { variant: 'type-project', icon: 'ph-kanban' };
  }
  if (t.includes('ćwicz') || t.includes('cwicz') || t.includes('lektorat') || t.includes('wf')) {
    return { variant: 'type-exercise', icon: 'ph-pencil-line' };
  }
  if (t.includes('seminarium')) {
    return { variant: 'type-seminar', icon: 'ph-chats-circle' };
  }
  if (t.includes('konsultac') || t.includes('promotor') || t.includes('spotkanie')) {
    return { variant: 'type-consult', icon: 'ph-user-focus' };
  }
  if (t.includes('odrabianie')) {
    return { variant: 'type-makeup', icon: 'ph-clock-clockwise' };
  }
  if (t.includes('lekarz') || t.includes('dentyst') || t.includes('prywatn') || t.includes('badani')) {
    return { variant: 'type-other', icon: 'ph-first-aid-kit' };
  }
  if (t.includes('warsztat') || t.includes('szkoleni') || t.includes('kurs') || t.includes('trening')) {
    return { variant: 'type-exercise', icon: 'ph-wrench' };
  }
  if (t.includes('koło') || t.includes('kolo') || t.includes('zebranie') || t.includes('rada')) {
    return { variant: 'type-consult', icon: 'ph-users-three' };
  }
  return {
    variant: 'type-other',
    icon: isCustom ? 'ph-calendar-star' : 'ph-tag',
  };
}

function renderEvent(event, layout, gridStartMin, specialDay = null) {
  const { title, isCustom } = getEventDisplay(event);
  const typeVisual = getEventTypeVisual(event.type, isCustom);
  const startMin = toMinutes(event.start);
  const endMin = toMinutes(event.end);
  const durationMin = Math.max(SLOT_MINUTES, endMin - startMin);
  const cancelledByRector = isEventCancelledByRector(event, specialDay);

  const EVENT_INSET_PX = 1;
  const topPx = ((startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + EVENT_INSET_PX;
  const heightPx = Math.max(
    SLOT_HEIGHT_PX - EVENT_INSET_PX * 2,
    (durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - EVENT_INSET_PX * 2,
  );

  let className = `event ${typeVisual.variant}`;
  if (event.remote) className += ' remote';
  if (isCustom) className += ' custom-event';
  if (cancelledByRector) className += ' cancelled-by-rector';
  if (durationMin < 20) className += ' compact';
  else if (durationMin <= 40) className += ' short-block';
  else if (durationMin <= 55) className += ' medium-block';
  else className += ' tall-block';

  const button = node('button', className);
  button.type = 'button';
  button.dataset.startMin = String(startMin);
  button.dataset.endMin = String(endMin);
  button.title = [
    `${event.start} – ${event.end}`,
    title,
    event.type,
    event.room,
    event.teacher,
  ]
    .filter(Boolean)
    .join(' · ');
  button.style.top = `${topPx}px`;
  button.style.height = `${heightPx}px`;

  const { col = 0, totalCols = 1, overlaps = false } = layout || {};
  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;
  button.style.left = `calc(${leftPct}% + 3px)`;
  button.style.width = `calc(${widthPct}% - 6px)`;

  const topRow = node('div', 'event-top-row');
  topRow.append(node('span', 'time', `${event.start} – ${event.end}`));

  if (cancelledByRector) {
    const rectorTag = node('span', 'rector-tag');
    rectorTag.innerHTML = '<i class="ph ph-graduation-cap"></i><span>Odwołane</span>';
    topRow.append(rectorTag);
  }
  if (isCustom) {
    const customTag = node('span', 'custom-tag');
    customTag.innerHTML = '<i class="ph ph-star-four"></i><span>Własne</span>';
    topRow.append(customTag);
  }
  if (event.remote) {
    const remoteTag = node('span', 'remote-tag');
    remoteTag.innerHTML = '<i class="ph ph-laptop"></i><span>Zdalnie</span>';
    topRow.append(remoteTag);
  }

  button.append(topRow, node('span', 'name', title));

  if (event.room || event.teacher) {
    button.append(node('span', 'meta', [event.room, event.teacher].filter(Boolean).join(' · ')));
  }

  const typeTag = node('span', `type-tag ${typeVisual.variant}`);
  typeTag.innerHTML = `<i class="ph ${typeVisual.icon}"></i>`;
  typeTag.append(node('span', '', event.type));
  button.append(typeTag);

  if (overlaps) button.append(node('span', 'meta', '⚠ Nakładające się godziny'));

  if (event.notes) button.append(node('span', 'meta', event.notes));

  button.onclick = (e) => {
    e.stopPropagation();
    if (editMode) {
      openEventDialog(event.id);
    } else {
      openEventDetailsDialog(event.id);
    }
  };
  return button;
}

// --- Szczegóły zajęć (w trybie przeglądania) ---------------------------------

function openEventDetailsDialog(id) {
  const event = state.plan.events.find((e) => e.id === id);
  if (!event) return;
  const { title, isCustom, subject } = getEventDisplay(event);
  const typeVisual = getEventTypeVisual(event.type, isCustom);

  detailsEventId = event.id;

  $('detailsSubjectName').textContent = title;
  $('detailsType').innerHTML = `<i class="ph ${typeVisual.icon}"></i> `;
  $('detailsType').append(document.createTextNode(event.type));
  $('detailsCustom').hidden = !isCustom;
  $('detailsRemote').hidden = !event.remote;
  $('detailsDate').textContent = formatFullDate(event.date);
  $('detailsTime').textContent = `${event.start} – ${event.end} (${formatDuration(toMinutes(event.end) - toMinutes(event.start))})`;

  $('detailsRoom').textContent = event.room || 'Nie podano';
  $('detailsTeacher').textContent = event.teacher || 'Nie podano';
  $('detailsRoomRow').hidden = isCustom && !event.room;
  $('detailsTeacherRow').hidden = isCustom && !event.teacher;

  const hasNotes = !!event.notes?.trim();
  $('detailsNotesSection').hidden = !hasNotes;
  renderRichTextWithLinks($('detailsNotes'), event.notes || '');
  $('copyEventNotesBtn').onclick = () =>
    copyTextWithFeedback(event.notes || '', $('copyEventNotesBtn'), 'Kopiuj notatkę');

  if (isCustom || !subject) {
    $('detailsSubjectSection').hidden = true;
    $('detailsEditSubjectBtn').hidden = true;
  } else {
    $('detailsEditSubjectBtn').hidden = false;
    $('detailsSubjectSection').hidden = !setSubjectDetailsContent(subject.details);
    $('copySubjectDetailsBtn').hidden = !subject.details?.trim();
    $('copySubjectDetailsBtn').onclick = () =>
      copyTextWithFeedback(subject.details || '', $('copySubjectDetailsBtn'), 'Kopiuj opis');
  }

  showDialogModal($('eventDetailsDialog'));
}

function setSubjectDetailsContent(details) {
  const text = (details || '').trim();
  if (text) {
    renderRichTextWithLinks($('detailsSubjectInfo'), text);
  } else {
    $('detailsSubjectInfo').textContent =
      'Brak opisu przedmiotu. Możesz go dodać przyciskiem „Edytuj opis przedmiotu”.';
  }
  return true;
}

// --- Przedmioty --------------------------------------------------------------

function fillSubjectForm(subject) {
  $('subjectId').value = subject.id;
  $('subjectName').value = subject.name;
  $('subjectDetails').value = subject.details || '';
  $('subjectError').textContent = '';
}

function renderSubjectList() {
  const list = $('subjectList');
  list.replaceChildren();

  for (const subject of state.plan.subjects) {
    const row = node('div', 'subjectrow');

    const info = node('div', 'subjectrow-info');
    const nameRow = node('div', 'subjectrow-name');
    const icon = node('i', 'ph ph-book-bookmark');
    nameRow.append(icon, node('span', '', subject.name));
    info.append(nameRow);

    if (subject.details) {
      info.append(node('div', 'subjectrow-details', subject.details));
    }

    const editButton = node('button', '', 'Edytuj');
    editButton.type = 'button';
    const deleteButton = node('button', 'danger', 'Usuń');
    deleteButton.type = 'button';

    editButton.onclick = () => fillSubjectForm(subject);
    deleteButton.onclick = () => deleteSubject(subject);

    row.append(info, editButton, deleteButton);
    list.append(row);
  }
}

function openSubjectDialog(message = '', subjectToEdit = null) {
  renderSubjectList();
  resetSubjectForm();
  if (subjectToEdit) fillSubjectForm(subjectToEdit);
  $('subjectError').textContent = message;
  showDialogModal($('subjectDialog'));
}

function resetSubjectForm() {
  $('subjectForm').reset();
  $('subjectId').value = '';
  $('subjectDetails').value = '';
}

function deleteSubject(subject) {
  try {
    const subjectEventsCount = state.plan.events.filter((e) => e.subjectId === subject.id).length;
    if (subjectEventsCount > 0) {
      if (
        !confirm(
          `Przedmiot „${subject.name}” ma przypisane zajęcia (${subjectEventsCount} spotkań). Czy usunąć ten przedmiot razem ze wszystkimi jego zajęciami?`,
        )
      ) {
        return;
      }
    } else if (!confirm(`Usunąć przedmiot „${subject.name}”?`)) {
      return;
    }

    mutate((plan) => {
      plan.events = plan.events.filter((e) => e.subjectId !== subject.id);
      plan.subjects = plan.subjects.filter((s) => s.id !== subject.id);
    });
    resetSubjectForm();
    renderSubjectList();
  } catch (err) {
    $('subjectError').textContent = err.message;
  }
}

function saveSubject(event) {
  event.preventDefault();
  try {
    const name = $('subjectName').value.trim();
    const id = $('subjectId').value || uid();
    const details = $('subjectDetails').value.trim();

    mutate((plan) => {
      const duplicate = plan.subjects.find(
        (s) => s.id !== id && s.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl'),
      );
      if (duplicate) throw Error('Taki przedmiot już istnieje. Dodaj do niego inny typ zajęć.');

      const subject = details ? { id, name, details } : { id, name };
      const index = plan.subjects.findIndex((s) => s.id === id);
      if (index < 0) plan.subjects.push(subject);
      else plan.subjects[index] = subject;
    });

    resetSubjectForm();
    $('subjectError').textContent = '';
    renderSubjectList();
  } catch (err) {
    $('subjectError').textContent = err.message;
  }
}

// --- Zajęcia -----------------------------------------------------------------

const EVENT_FIELDS = ['start', 'end', 'room', 'teacher', 'notes'];
const CUSTOM_TYPE_VALUE = '__custom__';

function setSelectedEventType(typeValue, isCustomEvent = false) {
  const select = $('typeSelect');
  const customInput = $('typeCustom');
  const val = (typeValue || (isCustomEvent ? 'Spotkanie' : 'Laboratorium')).trim();

  const matchingOption = Array.from(select.options).find(
    (opt) => opt.value !== CUSTOM_TYPE_VALUE && opt.value.toLowerCase() === val.toLowerCase(),
  );

  if (matchingOption) {
    select.value = matchingOption.value;
    customInput.value = '';
    customInput.hidden = true;
    customInput.required = false;
  } else {
    select.value = CUSTOM_TYPE_VALUE;
    customInput.value = val;
    customInput.hidden = false;
    customInput.required = true;
  }
}

function getSelectedEventType(isCustomEvent = false) {
  if ($('typeSelect').value === CUSTOM_TYPE_VALUE) {
    return $('typeCustom').value.trim() || (isCustomEvent ? 'Wydarzenie własne' : 'Laboratorium');
  }
  return $('typeSelect').value;
}

function updateTypeSelectFields() {
  const isCustomType = $('typeSelect').value === CUSTOM_TYPE_VALUE;
  const customInput = $('typeCustom');
  customInput.hidden = !isCustomType;
  customInput.required = isCustomType;
  if (isCustomType) {
    customInput.focus();
  }
}

function findDefaultNonHolidayDate(preferredDate) {
  if (!holidayFor(preferredDate, state.plan.academicYear)) return preferredDate;
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(week, i);
    if (!holidayFor(candidate, state.plan.academicYear)) return candidate;
  }
  return preferredDate;
}

function updateSubjectSelectionFields() {
  const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
  $('customEventFields').hidden = !isCustom;
  $('customTitle').required = isCustom;
  $('subjectHint').textContent = isCustom
    ? 'Wydarzenie poza przedmiotem (np. spotkanie z promotorem, wizyta u lekarza). Sala, osoba i czas zakończenia są opcjonalne (domyślny czas trwania: 1 godzina).'
    : 'Nowy przedmiot oraz jego opis dodasz w przycisku „Przedmioty”.';

  $('startLabelText').textContent = isCustom ? 'Od (domyślnie 12:00)' : 'Od';
  $('endLabelText').textContent = isCustom ? 'Do (opcjonalnie, domyślnie +1 godz.)' : 'Do';
  $('roomLabelText').textContent = isCustom ? 'Miejsce / Sala (opcjonalnie)' : 'Sala (opcjonalnie)';
  $('teacherLabelText').textContent = isCustom ? 'Osoba / Prowadzący (opcjonalnie)' : 'Prowadzący (opcjonalnie)';

  if (!editingId) {
    if (isCustom && $('typeSelect').value === 'Laboratorium') {
      setSelectedEventType('Spotkanie', true);
    } else if (!isCustom && $('typeSelect').value === 'Spotkanie') {
      setSelectedEventType('Laboratorium', false);
    }
    if (isCustom && $('start').value === '08:00' && $('end').value === '09:30') {
      $('end').value = '09:00';
    }
  }
}

function openEventDialog(id, initialDate = null, initialStart = null) {
  if (busy) return;

  editingId = id || null;
  const event = state.plan.events.find((e) => e.id === id);

  $('eventForm').reset();
  $('eventError').textContent = '';

  const select = $('subject');
  select.replaceChildren();
  for (const subject of state.plan.subjects) {
    const option = node('option', '', subject.name);
    option.value = subject.id;
    select.append(option);
  }
  const customOption = node(
    'option',
    '',
    '★ Wydarzenie własne / poza przedmiotem (np. promotor, dentysta)',
  );
  customOption.value = CUSTOM_SUBJECT_VALUE;
  select.append(customOption);

  $('eventTitle').textContent = event ? 'Edytuj zajęcia / wydarzenie' : 'Dodaj zajęcia lub wydarzenie';
  $('repeatFields').hidden = !!event;
  $('scopeLabel').hidden = !event;
  $('deleteEvent').hidden = !event;
  $('untilLabel').hidden = true;
  $('manualLabel').hidden = true;
  $('applyAcademicYearLabel').hidden = true;
  $('until').required = false;

  const t = today();
  const todayInWeek = t >= week && t <= addDays(week, 6);
  const fallbackDate = findDefaultNonHolidayDate(todayInWeek ? t : week);
  const targetDate = event?.date || initialDate || fallbackDate;
  $('date').value = targetDate;

  if (event) {
    for (const field of EVENT_FIELDS) $(field).value = event[field];
    setSelectedEventType(event.type, !event.subjectId);
    $('remote').checked = !!event.remote;
    if (event.subjectId) {
      select.value = event.subjectId;
      $('customTitle').value = '';
    } else {
      select.value = CUSTOM_SUBJECT_VALUE;
      $('customTitle').value = event.customTitle || '';
    }
    $('scope').value = 'one';
  } else {
    $('remote').checked = false;
    $('customTitle').value = '';
    const isTargetHoliday = !!holidayFor(targetDate, state.plan.academicYear);
    const targetSpecial = (state.plan.academicYear?.specialDays || []).find(
      (sd) => sd.date === targetDate,
    );
    const isTargetSession = targetSpecial?.type === 'session';
    const defaultToCustom = !state.plan.subjects.length || isTargetHoliday;
    if (defaultToCustom) {
      select.value = CUSTOM_SUBJECT_VALUE;
    }
    const defaultType = defaultToCustom
      ? 'Spotkanie'
      : isTargetSession
        ? 'Egzamin'
        : 'Laboratorium';
    setSelectedEventType(defaultType, defaultToCustom);
    const startVal = initialStart || (defaultToCustom ? '12:00' : '08:00');
    const defaultDurationMin = defaultToCustom ? 60 : 90;
    $('start').value = startVal;
    $('end').value = fromMinutes(Math.min(23 * 60 + 55, toMinutes(startVal) + defaultDurationMin));
  }

  updateSubjectSelectionFields();
  showDialogModal($('eventDialog'));
}

function updateRepeatFields() {
  const mode = $('repeat').value;
  const repeating = mode === 'weekly' || mode === 'biweekly';
  $('untilLabel').hidden = !repeating;
  $('until').required = repeating;
  $('manualLabel').hidden = mode !== 'manual';
  $('applyAcademicYearLabel').hidden = !repeating;
}

function readEventForm() {
  const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
  const start = $('start').value.trim() || (isCustom ? '12:00' : '08:00');
  const defaultDuration = isCustom ? 60 : 90;
  const end =
    $('end').value.trim() ||
    fromMinutes(Math.min(23 * 60 + 55, toMinutes(start) + defaultDuration));

  const base = {
    subjectId: isCustom ? null : $('subject').value,
    type: getSelectedEventType(isCustom),
    date: $('date').value,
    start,
    end,
    room: $('room').value.trim(),
    teacher: $('teacher').value.trim(),
    notes: $('notes').value.trim(),
    remote: $('remote').checked,
  };
  if (isCustom) {
    base.customTitle = $('customTitle').value.trim();
  }
  return base;
}

/**
 * Czy zajęcia `e` należą do wybranego zakresu edycji/usuwania:
 *  - 'one'    → tylko to jedno spotkanie,
 *  - 'future' → to i wszystkie kolejne spotkania z tej samej serii,
 *  - 'all'    → cała seria (wszystkie tygodnie oraz dni przeniesione).
 */
function inScope(e, original, scope) {
  if (e.id === original.id) return true;
  if (scope === 'all') return e.seriesId === original.seriesId;
  if (scope === 'future') return e.seriesId === original.seriesId && e.date >= original.date;
  return false;
}

function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  try {
    const values = readEventForm();
    if (values.end <= values.start) {
      throw Error('Godzina zakończenia musi być późniejsza niż rozpoczęcia.');
    }

    const applyAcademicYear = $('applyAcademicYear').checked;
    const isCustom = !values.subjectId;

    mutate((plan) => {
      if (editingId) {
        const original = plan.events.find((e) => e.id === editingId);
        const scope = $('scope').value;
        const shiftDays = Math.round((Date.parse(values.date) - Date.parse(original.date)) / 86_400_000);

        if (!isCustom && shiftDays !== 0) {
          const targetHoliday = holidayFor(values.date, plan.academicYear);
          if (targetHoliday) {
            const reason = targetHoliday.label ? ` (${targetHoliday.label})` : '';
            throw Error(
              `${values.date} to dzień wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`,
            );
          }
        }

        plan.events = plan.events.map((e) => {
          if (!inScope(e, original, scope)) return e;
          const nextDate = addDays(e.date, shiftDays);
          // Jeśli przesuwamy serię zajęć przedmiotu i któryś z docelowych dni jest dniem wolnym, pomijamy go
          if (!isCustom && shiftDays !== 0 && holidayFor(nextDate, plan.academicYear)) {
            return null;
          }
          const updated = { ...e, ...values, date: nextDate };
          if (values.subjectId) {
            delete updated.customTitle;
            delete updated.customColor;
          }
          return updated;
        }).filter(Boolean);
      } else {
        const repeatMode = $('repeat').value;
        // Blokada rozpoczęcia powtarzania lub pojedynczych zajęć przedmiotu w dniu wolnym lub w weekend
        if (!isCustom && applyAcademicYear) {
          const startHoliday = holidayFor(values.date, plan.academicYear);
          if (startHoliday) {
            const reason = startHoliday.label ? ` (${startHoliday.label})` : '';
            throw Error(
              `Wybrany dzień (${values.date}) jest ustawiony jako wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`,
            );
          }
        }

        const seriesId = uid();
        const dates = datesFor(
          values.date,
          $('until').value,
          repeatMode,
          $('manual').value,
          plan.academicYear,
          applyAcademicYear,
          isCustom,
        );
        for (const date of dates) {
          plan.events.push({ ...values, date, id: uid(), seriesId });
        }
      }
    });

    $('eventDialog').close();
  } catch (err) {
    $('eventError').textContent = err.message;
  }
}

function deleteEvent() {
  const scope = $('scope').value;
  let confirmMsg = 'Czy na pewno usunąć tylko to jedno spotkanie z planu?';
  if (scope === 'future') {
    confirmMsg = 'Czy na pewno usunąć to i wszystkie kolejne spotkania tej serii?';
  } else if (scope === 'all') {
    confirmMsg = 'Czy na pewno usunąć CAŁĄ serię zajęć (ze wszystkich tygodni oraz przeniesionych dni)?';
  }

  if (!confirm(confirmMsg)) return;

  try {
    mutate((plan) => {
      const original = plan.events.find((e) => e.id === editingId);
      plan.events = plan.events.filter((e) => !inScope(e, original, scope));
    });
    $('eventDialog').close();
  } catch (err) {
    $('eventError').textContent = err.message;
  }
}

// --- Masowe usuwanie serii i czyszczenie kalendarza --------------------------

function renderSeriesList() {
  const container = $('seriesList');
  container.replaceChildren();

  if (!state.plan.events.length) {
    container.append(node('p', 'hint', 'Kalendarz nie zawiera obecnie żadnych zajęć.'));
    return;
  }

  const groups = new Map();
  for (const e of state.plan.events) {
    if (!groups.has(e.seriesId)) groups.set(e.seriesId, []);
    groups.get(e.seriesId).push(e);
  }

  const subjectMap = new Map(state.plan.subjects.map((s) => [s.id, s]));

  for (const [seriesId, events] of groups) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    const first = events[0];
    const last = events[events.length - 1];
    const { title: subjectName } = getEventDisplay(first);

    const row = node('div', 'seriesrow');
    const info = node('div', 'seriesrow-info');
    info.append(
      node('div', 'seriesrow-title', `${subjectName} · ${first.type} (${first.start}–${first.end})`),
      node(
        'div',
        'seriesrow-meta',
        events.length > 1
          ? `Spotkań: ${events.length} · Zakres: ${first.date} → ${last.date}`
          : `Pojedyncze spotkanie: ${first.date}`,
      ),
    );

    const delBtn = node('button', 'danger', events.length > 1 ? `Usuń serię (${events.length})` : 'Usuń');
    delBtn.type = 'button';
    delBtn.onclick = () => {
      if (
        !confirm(
          `Usunąć wszystkie spotkania z serii „${subjectName} (${first.type})” (${events.length} terminów, w tym przeniesione dni)?`,
        )
      ) {
        return;
      }
      mutate((plan) => {
        plan.events = plan.events.filter((e) => e.seriesId !== seriesId);
      });
      renderSeriesList();
    };

    row.append(info, delBtn);
    container.append(row);
  }
}

function openBulkDialog() {
  if (!editMode) return;
  renderSeriesList();
  showDialogModal($('bulkDialog'));
}

function runReconcile() {
  try {
    let summary = { removed: 0, added: 0 };
    mutate((plan) => {
      const res = reconcileWithAcademicYear(plan, uid);
      plan.events = res.events;
      summary = { removed: res.removed, added: res.added };
    });
    renderSeriesList();
    setStatus(
      `Przeliczono serie wg struktury roku: usunięto ${summary.removed} z dni wolnych/zamienionych, dodano ${summary.added} w dniach z zamianą planu.`,
    );
  } catch (err) {
    setStatus(err.message);
  }
}

function clearAllEvents() {
  if (!state.plan.events.length) {
    setStatus('Brak zajęć do usunięcia.');
    return;
  }
  if (
    !confirm(
      `Czy na pewno usunąć WSZYSTKIE zajęcia (${state.plan.events.length} spotkań) z kalendarza? Przedmioty oraz struktura roku zostaną zachowane.`,
    )
  ) {
    return;
  }

  mutate((plan) => {
    plan.events = [];
  });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Usunięto wszystkie zajęcia. Kliknij „Zapisz w chmurze”, jeśli chcesz nadpisać również plan w chmurze.');
}

function clearEntireCalendar() {
  if (
    !confirm(
      'Czy na pewno wyczyścić CAŁY kalendarz do zera (wszystkie zajęcia, przedmioty oraz strukturę roku)? Tej operacji nie można cofnąć lokalnie bez kopii JSON.',
    )
  ) {
    return;
  }

  mutate((plan) => {
    Object.assign(plan, emptyPlan());
  });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Kalendarz został całkowicie wyczyszczony do zera. Kliknij „Zapisz w chmurze”, aby nadpisać dane w chmurze.');
}

// --- Struktura roku akademickiego ------------------------------------------

function groupSpecialDays(specialDays) {
  const sorted = [...specialDays].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];

    if (current.type === 'holiday' || current.type === 'session') {
      let j = i;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].type === current.type &&
        (sorted[j + 1].label || '') === (current.label || '') &&
        sorted[j + 1].date === addDays(sorted[j].date, 1)
      ) {
        j++;
      }

      if (j > i) {
        groups.push({
          type: current.type,
          label: current.label,
          startDate: current.date,
          endDate: sorted[j].date,
          count: j - i + 1,
          dates: sorted.slice(i, j + 1).map((x) => x.date),
        });
        i = j;
        continue;
      }
    }

    groups.push({
      type: current.type,
      label: current.label,
      targetDay: current.targetDay,
      start: current.start,
      end: current.end,
      startDate: current.date,
      endDate: current.date,
      count: 1,
      dates: [current.date],
    });
  }

  return groups;
}

function renderSpecialDaysList() {
  const container = $('specialDayList');
  container.replaceChildren();

  const specialDays = state.plan.academicYear?.specialDays || [];

  if (!specialDays.length) {
    container.append(
      node('p', 'hint', 'Brak zdefiniowanych dni wolnych, sesji, przerw i godzin rektorskich. Dodaj je poniżej.'),
    );
    return;
  }

  const groups = groupSpecialDays(specialDays);

  for (const group of groups) {
    const row = node('div', 'specialdayrow');
    const info = node('div', 'specialdayrow-info');

    const dateLine = node('div', 'specialdayrow-date');
    const isRange = group.count > 1;
    let badgeText = 'Zamiana';
    if (group.type === 'holiday') {
      badgeText = isRange ? `Przerwa (${group.count} dni)` : 'Wolne';
    } else if (group.type === 'session') {
      badgeText = isRange ? `Sesja (${group.count} dni)` : 'Sesja';
    } else if (group.type === 'rector') {
      badgeText = group.start && group.end ? `Rektorskie ${group.start}–${group.end}` : 'Dzień rektorski';
    }
    const badge = node('span', `badge ${group.type}`, badgeText);

    const dateRangeStr = isRange ? `${group.startDate} → ${group.endDate}` : group.startDate;
    dateLine.append(node('span', '', dateRangeStr), badge);

    let descText =
      group.label ||
      (group.type === 'holiday'
        ? isRange
          ? 'Przerwa świąteczna / wolna'
          : 'Dzień wolny'
        : group.type === 'session'
          ? isRange
            ? 'Sesja egzaminacyjna / poprawkowa (brak zwykłych zajęć)'
            : 'Dzień sesji egzaminacyjnej'
          : '');
    if (group.type === 'swap') {
      const targetName = DAY_KEY_NAMES[group.targetDay] || group.targetDay;
      const swapDesc = `Zajęcia według planu z ${targetName}`;
      descText = descText ? `${swapDesc} (${descText})` : swapDesc;
    } else if (group.type === 'rector') {
      const rectorDesc =
        group.start && group.end
          ? `Godziny rektorskie ${group.start} – ${group.end} (nakładka na plan)`
          : 'Dzień rektorski — cały dzień (nakładka na plan)';
      descText = group.label ? `${rectorDesc} · ${group.label}` : rectorDesc;
    }
    const desc = node('div', 'specialdayrow-desc', descText);

    info.append(dateLine, desc);

    const deleteBtn = node('button', 'danger', 'Usuń');
    deleteBtn.type = 'button';
    deleteBtn.onclick = () => deleteSpecialDays(group.dates);

    row.append(info, deleteBtn);
    container.append(row);
  }
}

function openAcademicYearDialog() {
  if (!editMode) return;
  renderSpecialDaysList();
  $('academicYearError').textContent = '';
  $('specialDayDate').value = today();
  $('specialDayDateEnd').value = addDays(today(), 7);
  $('specialDayLabel').value = '';
  $('specialDayType').value = 'holiday_range';
  $('rectorFullDay').checked = false;
  $('rectorStart').value = '10:00';
  $('rectorEnd').value = '14:00';
  updateSpecialDayTypeFields();
  showDialogModal($('academicYearDialog'));
}

function updateSpecialDayTypeFields() {
  const type = $('specialDayType').value;
  const isSwap = type === 'swap';
  const isRange = type === 'holiday_range' || type === 'session_range';
  const isRector = type === 'rector';
  const fullDayRector = $('rectorFullDay').checked;

  $('swapTargetContainer').hidden = !isSwap;
  $('dateEndContainer').hidden = !isRange;
  $('specialDayDateEnd').required = isRange;
  $('rectorHoursContainer').hidden = !isRector;
  $('rectorTimePair').hidden = !isRector || fullDayRector;
  $('rectorStart').required = isRector && !fullDayRector;
  $('rectorEnd').required = isRector && !fullDayRector;

  const dateLabel = $('specialDayDateLabel');
  if (isRange) {
    dateLabel.childNodes[0].textContent = 'Data od: ';
  } else {
    dateLabel.childNodes[0].textContent = 'Data: ';
  }
}

function deleteSpecialDays(datesToDelete) {
  try {
    const toRemove = new Set(datesToDelete);
    mutate((plan) => {
      if (!plan.academicYear) plan.academicYear = { specialDays: [] };
      plan.academicYear.specialDays = plan.academicYear.specialDays.filter((sd) => !toRemove.has(sd.date));
    });
    renderSpecialDaysList();
  } catch (err) {
    $('academicYearError').textContent = err.message;
  }
}

function saveSpecialDay(event) {
  event.preventDefault();
  try {
    const type = $('specialDayType').value;
    const startDate = $('specialDayDate').value;
    const endDate = $('specialDayDateEnd').value;
    const label = $('specialDayLabel').value.trim();
    const targetDay = type === 'swap' ? $('specialDayTargetDay').value : undefined;
    const rectorFullDay = $('rectorFullDay').checked;
    const rectorStart = $('rectorStart').value;
    const rectorEnd = $('rectorEnd').value;

    if (type === 'rector' && !rectorFullDay) {
      if (!rectorStart || !rectorEnd || rectorEnd <= rectorStart) {
        throw Error('Godzina zakończenia godzin rektorskich musi być późniejsza niż godzina rozpoczęcia.');
      }
    }

    const datesToAdd = [];

    if (type === 'holiday_range' || type === 'session_range') {
      if (!endDate || endDate < startDate) {
        throw Error('Data końcowa musi być późniejsza lub równa dacie początkowej.');
      }
      for (let cur = startDate; cur <= endDate; cur = addDays(cur, 1)) {
        if (datesToAdd.length >= 366) {
          throw Error('Zakres nie może trwać dłużej niż 366 dni.');
        }
        datesToAdd.push(cur);
      }
    } else {
      datesToAdd.push(startDate);
    }

    mutate((plan) => {
      if (!plan.academicYear) plan.academicYear = { specialDays: [] };

      // Sprawdź, czy któryś dzień nie jest już zajęty
      const existingMap = new Map(plan.academicYear.specialDays.map((sd) => [sd.date, sd]));
      for (const d of datesToAdd) {
        if (existingMap.has(d)) {
          throw Error(`Dla dnia ${d} już istnieje wpis w strukturze roku. Najpierw go usuń.`);
        }
      }

      const normalizedType =
        type === 'session' || type === 'session_range'
          ? 'session'
          : type === 'swap'
            ? 'swap'
            : 'holiday';

      for (const d of datesToAdd) {
        if (type === 'rector') {
          const item = { date: d, type: 'rector', label };
          if (!rectorFullDay) {
            item.start = rectorStart;
            item.end = rectorEnd;
          }
          plan.academicYear.specialDays.push(item);
        } else {
          const item = { date: d, type: normalizedType, label };
          if (type === 'swap') item.targetDay = targetDay;
          plan.academicYear.specialDays.push(item);
        }
      }

      // Automatycznie dopasuj istniejące serie cykliczne do zaktualizowanej struktury roku
      const reconciled = reconcileWithAcademicYear(plan, uid);
      plan.events = reconciled.events;
    });

    $('specialDayLabel').value = '';
    $('academicYearError').textContent = '';
    renderSpecialDaysList();
  } catch (err) {
    $('academicYearError').textContent = err.message;
  }
}

// --- Tablica Kanban (osobny plik kanban.json + chmura /api/kanban) -----------

const PRIORITY_LABELS = {
  high: 'Wysoki',
  medium: 'Średni',
  low: 'Niski',
};

const PRIORITY_WEIGHT = {
  high: 0,
  medium: 1,
  low: 2,
};

function renderKanbanBadge() {
  const badge = $('kanbanCountBadge');
  if (!badge) return;
  const cols = kanbanState.kanban.columns;
  const lastColId = cols.length > 1 ? cols[cols.length - 1].id : null;
  const activeCount = kanbanState.kanban.cards.filter((c) => c.columnId !== lastColId).length;
  badge.textContent = String(activeCount);
  badge.hidden = activeCount === 0;
}

function getDueDateStatus(dueDate, isDoneCol) {
  if (!dueDate) return null;
  const t = today();
  const diffDays = Math.round((Date.parse(dueDate + 'T12:00:00Z') - Date.parse(t + 'T12:00:00Z')) / 86_400_000);
  if (isDoneCol) {
    return { label: formatDate(dueDate), variant: 'done', icon: 'ph-calendar-check' };
  }
  if (diffDays < 0) {
    return {
      label: `Po terminie (${formatDate(dueDate)})`,
      variant: 'overdue',
      icon: 'ph-warning-circle',
    };
  }
  if (diffDays === 0) {
    return { label: 'Dzisiaj!', variant: 'due-soon', icon: 'ph-alarm' };
  }
  if (diffDays === 1) {
    return { label: 'Jutro', variant: 'due-soon', icon: 'ph-clock-countdown' };
  }
  if (diffDays <= 3) {
    return { label: `Za ${diffDays} dni (${formatDate(dueDate)})`, variant: 'due-soon', icon: 'ph-clock' };
  }
  return { label: formatDate(dueDate), variant: 'normal', icon: 'ph-calendar-blank' };
}

function updateKanbanSubjectFilterOptions() {
  const select = $('kanbanFilterSubject');
  const prevValue = select.value;

  const subjectSet = new Set();
  for (const s of state.plan.subjects) {
    if (s.name?.trim()) subjectSet.add(s.name.trim());
  }
  for (const c of kanbanState.kanban.cards) {
    if (c.subjectName?.trim()) subjectSet.add(c.subjectName.trim());
  }

  select.replaceChildren();
  const allOpt = node('option', '', 'Wszystkie przedmioty');
  allOpt.value = '';
  select.append(allOpt);

  const noneOpt = node('option', '', 'Ogólne (bez przedmiotu)');
  noneOpt.value = '__none__';
  select.append(noneOpt);

  for (const name of [...subjectSet].sort((a, b) => a.localeCompare(b, 'pl'))) {
    const opt = node('option', '', name);
    opt.value = name;
    select.append(opt);
  }

  if (Array.from(select.options).some((o) => o.value === prevValue)) {
    select.value = prevValue;
  }
}

function getFilteredKanbanCards() {
  const subjFilter = $('kanbanFilterSubject')?.value || '';
  const prioFilter = $('kanbanFilterPriority')?.value || '';
  const query = ($('kanbanSearch')?.value || '').trim().toLocaleLowerCase('pl');

  return kanbanState.kanban.cards.filter((card) => {
    if (subjFilter === '__none__' && card.subjectName) return false;
    if (subjFilter && subjFilter !== '__none__' && (card.subjectName || '') !== subjFilter) return false;
    if (prioFilter && card.priority !== prioFilter) return false;
    if (query) {
      const haystack = [
        card.title,
        card.description || '',
        card.subjectName || '',
        card.category || '',
        ...(card.checklist || []).map((i) => i.text),
      ]
        .join(' ')
        .toLocaleLowerCase('pl');
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderMobileKanbanTabs(filteredCards) {
  const nav = $('mobileKanbanTabs');
  nav.replaceChildren();

  const cols = kanbanState.kanban.columns;
  if (selectedKanbanColIndex >= cols.length) {
    selectedKanbanColIndex = Math.max(0, cols.length - 1);
  }

  cols.forEach((col, idx) => {
    const count = filteredCards.filter((c) => c.columnId === col.id).length;
    let cls = 'mobile-day-tab';
    if (idx === selectedKanbanColIndex) cls += ' active';

    const btn = node('button', cls);
    btn.type = 'button';
    btn.append(
      node('span', 'tab-code', col.title),
      node('span', 'tab-num', `${count}`),
    );
    btn.onclick = () => {
      if (selectedKanbanColIndex !== idx) {
        kanbanMobileSlideDir = idx > selectedKanbanColIndex ? 'slide-next' : 'slide-prev';
        selectedKanbanColIndex = idx;
        renderKanban();
      }
    };
    nav.append(btn);
  });
}

function moveKanbanCardToColumn(cardId, targetColumnId, targetIndex = null) {
  mutateKanban((kanban) => {
    const card = kanban.cards.find((c) => c.id === cardId);
    if (!card) return;
    card.columnId = targetColumnId;

    const colCards = kanban.cards
      .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
      .sort((a, b) => a.order - b.order);

    const insertAt =
      targetIndex === null
        ? colCards.length
        : Math.max(0, Math.min(colCards.length, targetIndex));
    colCards.splice(insertAt, 0, card);
    colCards.forEach((c, idx) => {
      c.order = idx;
    });
  });
}

function toggleKanbanChecklistItem(cardId, itemId) {
  mutateKanban((kanban) => {
    const card = kanban.cards.find((c) => c.id === cardId);
    const item = card?.checklist?.find((i) => i.id === itemId);
    if (item) item.done = !item.done;
  });
}

function openKanbanDetailsDialog(cardId) {
  const card = kanbanState.kanban.cards.find((c) => c.id === cardId);
  if (!card) return;
  detailsKanbanCardId = card.id;

  const col = kanbanState.kanban.columns.find((c) => c.id === card.columnId);
  const cols = kanbanState.kanban.columns;
  const isDoneCol = cols.length > 1 && cols[cols.length - 1]?.id === card.columnId;

  $('kanbanDetailsTitle').textContent = card.title;
  $('kanbanDetailsColumn').textContent = col ? col.title : 'Zadanie';
  $('kanbanDetailsPriority').textContent = `Priorytet: ${PRIORITY_LABELS[card.priority] || 'Średni'}`;

  if (card.category) {
    const typeVisual = getEventTypeVisual(card.category, false);
    $('kanbanDetailsCategory').hidden = false;
    $('kanbanDetailsCategory').innerHTML = `<i class="ph ${typeVisual.icon}"></i> `;
    $('kanbanDetailsCategory').append(document.createTextNode(card.category));
  } else {
    $('kanbanDetailsCategory').hidden = true;
  }

  if (card.subjectName) {
    $('kanbanDetailsSubject').hidden = false;
    $('kanbanDetailsSubject').innerHTML = '<i class="ph ph-book-bookmark"></i> ';
    $('kanbanDetailsSubject').append(document.createTextNode(card.subjectName));
  } else {
    $('kanbanDetailsSubject').hidden = true;
  }

  const dueInfo = getDueDateStatus(card.dueDate, isDoneCol);
  if (dueInfo) {
    $('kanbanDetailsDue').hidden = false;
    $('kanbanDetailsDue').innerHTML = `<i class="ph ${dueInfo.icon}"></i> `;
    $('kanbanDetailsDue').append(document.createTextNode(`Termin: ${dueInfo.label}`));
  } else {
    $('kanbanDetailsDue').hidden = true;
  }

  const hasDesc = Boolean(card.description?.trim());
  $('kanbanDetailsDescSection').hidden = !hasDesc;
  renderRichTextWithLinks($('kanbanDetailsDesc'), card.description || '');
  $('copyKanbanDescBtn').onclick = () =>
    copyTextWithFeedback(card.description || '', $('copyKanbanDescBtn'), 'Kopiuj notatkę');

  const hasCheck = Boolean(card.checklist && card.checklist.length > 0);
  $('kanbanDetailsChecklistSection').hidden = !hasCheck;
  const checkContainer = $('kanbanDetailsChecklist');
  checkContainer.replaceChildren();
  if (hasCheck) {
    const doneCount = card.checklist.filter((i) => i.done).length;
    $('kanbanDetailsChecklistHead').textContent = `Lista podzadań (${doneCount}/${card.checklist.length})`;
    for (const item of card.checklist) {
      const row = node('label', `kanban-card-checkitem${item.done ? ' done' : ''}`);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.done;
      cb.disabled = !editMode;
      cb.onchange = () => {
        if (!editMode) return;
        toggleKanbanChecklistItem(card.id, item.id);
        openKanbanDetailsDialog(card.id);
      };
      row.append(cb, node('span', '', item.text));
      checkContainer.append(row);
    }
  }

  showDialogModal($('kanbanDetailsDialog'));
}

function renderKanbanCard(card, colIndex, totalCols, isDoneCol) {
  const el = node(
    'article',
    `kanban-card priority-${card.priority}${isDoneCol ? ' is-done' : ''}${editMode ? ' editable' : ''}`,
  );
  el.draggable = editMode;
  el.dataset.cardId = card.id;

  if (editMode) {
    el.addEventListener('dragstart', (e) => {
      // Jeśli użytkownik zaznacza tekst w opisie/notatce, nie uruchamiamy przeciągania karty
      if (e.target?.closest?.('.kanban-card-desc, .rich-link-chip, .kanban-card-checklist')) {
        e.preventDefault();
        return;
      }
      draggedKanbanCardId = card.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
    });
    el.addEventListener('dragend', () => {
      draggedKanbanCardId = null;
      el.classList.remove('dragging');
      for (const colEl of document.querySelectorAll('.kanban-col.drag-over')) {
        colEl.classList.remove('drag-over');
      }
    });
  } else {
    el.onclick = (e) => {
      // Jeśli użytkownik właśnie zaznaczył tekst myszką (np. żeby skopiować fragment notatki), nie otwieramy okna
      const selection = window.getSelection?.()?.toString().trim();
      if (selection) return;
      if (e.target?.closest?.('a, button, input, label')) return;
      openKanbanDetailsDialog(card.id);
    };
  }

  // 1. Pasek plakietek na górze karty (Uchwyt przeciągania w trybie edycji, Priorytet, Kategoria, Przedmiot)
  const badgesRow = node('div', 'kanban-card-badges');

  if (editMode) {
    const dragHandle = node('span', 'kanban-drag-handle');
    dragHandle.title = 'Chwyć tutaj, aby przeciągnąć kartę';
    dragHandle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
    badgesRow.append(dragHandle);
  }

  const prioBadge = node('span', `kanban-prio-badge priority-${card.priority}`);
  const prioIcon =
    card.priority === 'high'
      ? 'ph-fire'
      : card.priority === 'medium'
        ? 'ph-flag'
        : 'ph-arrow-down-right';
  prioBadge.innerHTML = `<i class="ph ${prioIcon}"></i>`;
  prioBadge.append(node('span', '', PRIORITY_LABELS[card.priority] || 'Średni'));
  badgesRow.append(prioBadge);

  if (card.category) {
    const typeVisual = getEventTypeVisual(card.category, false);
    const catTag = node('span', `type-tag ${typeVisual.variant}`);
    catTag.innerHTML = `<i class="ph ${typeVisual.icon}"></i>`;
    catTag.append(node('span', '', card.category));
    badgesRow.append(catTag);
  }

  if (card.subjectName) {
    const subjBadge = node('span', 'kanban-subject-badge');
    subjBadge.innerHTML = '<i class="ph ph-book-bookmark"></i>';
    subjBadge.append(node('span', '', card.subjectName));
    badgesRow.append(subjBadge);
  }

  el.append(badgesRow);

  // 2. Tytuł zadania (w trybie edycji otwiera edycję, w trybie przeglądania szczegóły)
  const titleBtn = node('button', 'kanban-card-title-btn', card.title);
  titleBtn.type = 'button';
  titleBtn.onclick = (e) => {
    e.stopPropagation();
    if (editMode) {
      openKanbanCardDialog(card.id);
    } else {
      openKanbanDetailsDialog(card.id);
    }
  };
  el.append(titleBtn);

  // 3. Opis / notatka (z klikalnymi linkami, przyciskiem kopiowania i normalnym zaznaczaniem tekstu bez konfliktu z Drag & Drop)
  if (card.description?.trim()) {
    const descWrap = node('div', 'kanban-card-desc-wrap');
    const descEl = node('div', 'kanban-card-desc');
    renderRichTextWithLinks(descEl, card.description);

    // Wyłączamy draggable na karcie, gdy użytkownik operuje kursorem wewnątrz pola notatki,
    // dzięki czemu można swobodnie zaznaczyć myszką dowolny fragment tekstu lub linku!
    descWrap.addEventListener('mouseenter', () => {
      if (editMode) el.draggable = false;
    });
    descWrap.addEventListener('mouseleave', () => {
      if (editMode) el.draggable = true;
    });
    descWrap.addEventListener(
      'touchstart',
      () => {
        if (editMode) el.draggable = false;
      },
      { passive: true },
    );

    const previewActions = node('div', 'kanban-desc-bar');
    const viewNoteBtn = node('button', 'kanban-note-action-btn');
    viewNoteBtn.type = 'button';
    viewNoteBtn.innerHTML = '<i class="ph ph-eye"></i> <span>Podgląd notatki</span>';
    viewNoteBtn.onclick = (e) => {
      e.stopPropagation();
      openKanbanDetailsDialog(card.id);
    };

    const copyNoteBtn = node('button', 'kanban-note-action-btn');
    copyNoteBtn.type = 'button';
    copyNoteBtn.innerHTML = '<i class="ph ph-copy"></i> <span>Kopiuj</span>';
    copyNoteBtn.onclick = (e) => {
      e.stopPropagation();
      copyTextWithFeedback(card.description, copyNoteBtn, 'Kopiuj');
    };

    previewActions.append(viewNoteBtn, copyNoteBtn);
    descWrap.append(descEl, previewActions);
    el.append(descWrap);
  }

  // 4. Checklista podzadań na karcie (aktywna w trybie edycji, podgląd w trybie przeglądania)
  if (card.checklist && card.checklist.length > 0) {
    const doneCount = card.checklist.filter((i) => i.done).length;
    const totalCount = card.checklist.length;
    const pct = Math.round((doneCount / totalCount) * 100);

    const checkWrap = node('div', 'kanban-card-checklist');
    const progressHead = node('div', 'kanban-check-progress-head');
    const checkLabel = node('span', 'kanban-check-count');
    checkLabel.innerHTML = `<i class="ph ph-check-square-offset"></i> ${doneCount}/${totalCount}`;
    const pctLabel = node('span', 'kanban-check-pct', `${pct}%`);
    progressHead.append(checkLabel, pctLabel);

    const progressBar = node('div', 'kanban-check-bar');
    const progressFill = node('div', 'kanban-check-fill');
    progressFill.style.width = `${pct}%`;
    progressBar.append(progressFill);

    const listEl = node('div', 'kanban-card-checkitems');
    for (const item of card.checklist) {
      const itemLabel = node('label', `kanban-card-checkitem${item.done ? ' done' : ''}`);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.done;
      cb.disabled = !editMode;
      if (editMode) {
        cb.onchange = (e) => {
          e.stopPropagation();
          toggleKanbanChecklistItem(card.id, item.id);
        };
      }
      itemLabel.append(cb, node('span', '', item.text));
      listEl.append(itemLabel);
    }

    checkWrap.append(progressHead, progressBar, listEl);
    el.append(checkWrap);
  }

  // 5. Stopka karty: termin wykonania + przyciski szybkiego przesuwania i edycji (tylko w trybie edycji)
  const dueInfo = getDueDateStatus(card.dueDate, isDoneCol);
  if (dueInfo || editMode) {
    const footer = node('div', 'kanban-card-foot');

    if (dueInfo) {
      const dueBadge = node('span', `kanban-due-badge ${dueInfo.variant}`);
      dueBadge.innerHTML = `<i class="ph ${dueInfo.icon}"></i>`;
      dueBadge.append(node('span', '', dueInfo.label));
      footer.append(dueBadge);
    } else {
      footer.append(node('span', 'kanban-due-empty', ''));
    }

    if (editMode) {
      const actions = node('div', 'kanban-card-actions');
      if (colIndex > 0) {
        const prevCol = kanbanState.kanban.columns[colIndex - 1];
        const leftBtn = node('button', 'kanban-icon-btn');
        leftBtn.type = 'button';
        leftBtn.title = `Przenieś do: ${prevCol.title}`;
        leftBtn.setAttribute('aria-label', `Przenieś do: ${prevCol.title}`);
        leftBtn.innerHTML = '<i class="ph ph-arrow-left"></i>';
        leftBtn.onclick = (e) => {
          e.stopPropagation();
          moveKanbanCardToColumn(card.id, prevCol.id);
        };
        actions.append(leftBtn);
      }

      if (colIndex < totalCols - 1) {
        const nextCol = kanbanState.kanban.columns[colIndex + 1];
        const rightBtn = node('button', 'kanban-icon-btn');
        rightBtn.type = 'button';
        rightBtn.title = `Przenieś do: ${nextCol.title}`;
        rightBtn.setAttribute('aria-label', `Przenieś do: ${nextCol.title}`);
        rightBtn.innerHTML = '<i class="ph ph-arrow-right"></i>';
        rightBtn.onclick = (e) => {
          e.stopPropagation();
          moveKanbanCardToColumn(card.id, nextCol.id);
        };
        actions.append(rightBtn);
      }

      const editBtn = node('button', 'kanban-icon-btn');
      editBtn.type = 'button';
      editBtn.title = 'Edytuj zadanie';
      editBtn.setAttribute('aria-label', 'Edytuj zadanie');
      editBtn.innerHTML = '<i class="ph ph-pencil-simple"></i>';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        openKanbanCardDialog(card.id);
      };
      actions.append(editBtn);

      footer.append(actions);
    }

    el.append(footer);
  }

  return el;
}

function renderKanban() {
  renderKanbanBadge();
  updateKanbanSubjectFilterOptions();

  const cols = kanbanState.kanban.columns;
  const allCards = kanbanState.kanban.cards;
  const filteredCards = getFilteredKanbanCards();

  // Podsumowanie liczbowe nad tablicą
  const summaryParts = cols.map((col) => {
    const cnt = allCards.filter((c) => c.columnId === col.id).length;
    return `${col.title}: ${cnt}`;
  });
  $('kanbanSummary').textContent = summaryParts.join(' · ') || 'Brak kolumn';

  renderMobileKanbanTabs(filteredCards);

  const board = $('kanbanBoard');
  board.replaceChildren();
  board.style.setProperty('--kanban-cols', String(Math.max(1, cols.length)));

  const slideClass = kanbanMobileSlideDir;
  kanbanMobileSlideDir = '';

  cols.forEach((col, colIndex) => {
    const isLastCol = cols.length > 1 && colIndex === cols.length - 1;
    let colClass = 'kanban-col';
    if (colIndex === selectedKanbanColIndex) {
      colClass += ' mobile-active';
      if (slideClass) colClass += ` ${slideClass}`;
    }
    if (isLastCol) colClass += ' is-done-col';

    const colEl = node('section', colClass);
    colEl.dataset.columnId = col.id;

    // Nagłówek kolumny
    const head = node('div', 'kanban-col-head');
    const titleWrap = node('div', 'kanban-col-title-wrap');
    const colIcon =
      colIndex === 0
        ? 'ph-circle-dashed'
        : isLastCol
          ? 'ph-check-circle'
          : 'ph-spinner-gap';
    const iconEl = node('i', `ph ${colIcon}`);
    const titleEl = node('h3', 'kanban-col-title', col.title);
    const colCards = filteredCards
      .filter((c) => c.columnId === col.id)
      .sort((a, b) => a.order - b.order || (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1));
    const countBadge = node('span', 'kanban-col-count', String(colCards.length));
    titleWrap.append(iconEl, titleEl, countBadge);
    head.append(titleWrap);

    if (editMode) {
      const addBtn = node('button', 'kanban-col-add-btn');
      addBtn.type = 'button';
      addBtn.title = `Dodaj zadanie w kolumnie „${col.title}”`;
      addBtn.innerHTML = '<i class="ph ph-plus"></i>';
      addBtn.onclick = () => openKanbanCardDialog(null, col.id);
      head.append(addBtn);
    }

    colEl.append(head);

    // Lista kart w kolumnie + obsługa Drag & Drop (tylko w trybie edycji)
    const cardsContainer = node('div', 'kanban-cards');

    if (editMode) {
      colEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        colEl.classList.add('drag-over');
      });
      colEl.addEventListener('dragleave', (e) => {
        if (!colEl.contains(e.relatedTarget)) {
          colEl.classList.remove('drag-over');
        }
      });
      colEl.addEventListener('drop', (e) => {
        e.preventDefault();
        colEl.classList.remove('drag-over');
        const cardId = draggedKanbanCardId || e.dataTransfer.getData('text/plain');
        if (!cardId) return;

        // Wyznacz indeks docelowy na podstawie pozycji kursora Y względem kart w kolumnie
        const cardElements = [...cardsContainer.querySelectorAll('.kanban-card:not(.dragging)')];
        let targetIdx = cardElements.length;
        for (let i = 0; i < cardElements.length; i++) {
          const rect = cardElements[i].getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) {
            targetIdx = i;
            break;
          }
        }
        moveKanbanCardToColumn(cardId, col.id, targetIdx);
      });
    }

    if (!colCards.length) {
      if (editMode) {
        const emptyBtn = node('button', 'kanban-empty-col');
        emptyBtn.type = 'button';
        emptyBtn.innerHTML = '<i class="ph ph-plus-circle"></i><span>Brak zadań · Kliknij, aby dodać</span>';
        emptyBtn.onclick = () => openKanbanCardDialog(null, col.id);
        cardsContainer.append(emptyBtn);
      } else {
        const emptyInfo = node('div', 'kanban-empty-col readonly');
        emptyInfo.innerHTML = '<span>Brak zadań</span>';
        cardsContainer.append(emptyInfo);
      }
    } else {
      for (const card of colCards) {
        cardsContainer.append(renderKanbanCard(card, colIndex, cols.length, isLastCol));
      }
    }

    colEl.append(cardsContainer);
    board.append(colEl);
  });
}

// --- Okno dodawania / edycji zadania Kanban ----------------------------------

const KANBAN_CUSTOM_SUBJECT = '__custom_subject__';
const KANBAN_CUSTOM_CATEGORY = '__custom__';

function populateKanbanCardFormSelects(selectedSubject = '', selectedCategory = 'Projekt', selectedColumnId = '') {
  // 1. Kolumny
  const colSelect = $('kanbanCardColumn');
  colSelect.replaceChildren();
  for (const col of kanbanState.kanban.columns) {
    const opt = node('option', '', col.title);
    opt.value = col.id;
    colSelect.append(opt);
  }
  if (selectedColumnId && kanbanState.kanban.columns.some((c) => c.id === selectedColumnId)) {
    colSelect.value = selectedColumnId;
  }

  // 2. Przedmiot (z planu zajęć lub własny)
  const subjSelect = $('kanbanCardSubjectSelect');
  const subjCustom = $('kanbanCardSubjectCustom');
  subjSelect.replaceChildren();

  const noneOpt = node('option', '', '— Ogólne / bez przedmiotu —');
  noneOpt.value = '';
  subjSelect.append(noneOpt);

  const knownSubjectNames = new Set();
  for (const s of state.plan.subjects) {
    if (s.name?.trim()) knownSubjectNames.add(s.name.trim());
  }
  for (const c of kanbanState.kanban.cards) {
    if (c.subjectName?.trim()) knownSubjectNames.add(c.subjectName.trim());
  }

  for (const name of [...knownSubjectNames].sort((a, b) => a.localeCompare(b, 'pl'))) {
    const opt = node('option', '', name);
    opt.value = name;
    subjSelect.append(opt);
  }

  const customSubjOpt = node('option', '', '✎ Inny przedmiot / projekt (wpisz)...');
  customSubjOpt.value = KANBAN_CUSTOM_SUBJECT;
  subjSelect.append(customSubjOpt);

  if (!selectedSubject) {
    subjSelect.value = '';
    subjCustom.value = '';
    subjCustom.hidden = true;
    subjCustom.required = false;
  } else if (knownSubjectNames.has(selectedSubject)) {
    subjSelect.value = selectedSubject;
    subjCustom.value = '';
    subjCustom.hidden = true;
    subjCustom.required = false;
  } else {
    subjSelect.value = KANBAN_CUSTOM_SUBJECT;
    subjCustom.value = selectedSubject;
    subjCustom.hidden = false;
    subjCustom.required = true;
  }

  // 3. Kategoria zadania
  const catSelect = $('kanbanCardCategorySelect');
  const catCustom = $('kanbanCardCategoryCustom');
  const matchingCat = Array.from(catSelect.options).find(
    (o) => o.value !== KANBAN_CUSTOM_CATEGORY && o.value.toLowerCase() === (selectedCategory || '').toLowerCase(),
  );
  if (matchingCat) {
    catSelect.value = matchingCat.value;
    catCustom.value = '';
    catCustom.hidden = true;
    catCustom.required = false;
  } else {
    catSelect.value = KANBAN_CUSTOM_CATEGORY;
    catCustom.value = selectedCategory || '';
    catCustom.hidden = false;
    catCustom.required = true;
  }
}

function updateKanbanSubjectSelectFields() {
  const isCustom = $('kanbanCardSubjectSelect').value === KANBAN_CUSTOM_SUBJECT;
  const input = $('kanbanCardSubjectCustom');
  input.hidden = !isCustom;
  input.required = isCustom;
  if (isCustom) input.focus();
}

function updateKanbanCategorySelectFields() {
  const isCustom = $('kanbanCardCategorySelect').value === KANBAN_CUSTOM_CATEGORY;
  const input = $('kanbanCardCategoryCustom');
  input.hidden = !isCustom;
  input.required = isCustom;
  if (isCustom) input.focus();
}

function renderDraftChecklist() {
  const container = $('kanbanChecklistItems');
  container.replaceChildren();

  draftChecklist.forEach((item, idx) => {
    const row = node('div', 'kanban-draft-checkrow');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
    };

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = item.text;
    textInput.maxLength = 200;
    textInput.oninput = () => {
      item.text = textInput.value;
    };

    const removeBtn = node('button', 'danger kanban-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Usuń podpunkt';
    removeBtn.innerHTML = '<i class="ph ph-x"></i>';
    removeBtn.onclick = () => {
      draftChecklist.splice(idx, 1);
      renderDraftChecklist();
    };

    row.append(cb, textInput, removeBtn);
    container.append(row);
  });
}

function addDraftChecklistItem() {
  const input = $('kanbanNewCheckItem');
  const text = input.value.trim();
  if (!text) return;
  if (draftChecklist.length >= 50) {
    $('kanbanCardError').textContent = 'Maksymalnie 50 podzadań na jednej karcie.';
    return;
  }
  draftChecklist.push({ id: uid(), text, done: false });
  input.value = '';
  renderDraftChecklist();
  input.focus();
}

function openKanbanCardDialog(cardId = null, defaultColumnId = null) {
  if (busy) return;
  editingKanbanCardId = cardId || null;
  const card = kanbanState.kanban.cards.find((c) => c.id === cardId);

  $('kanbanCardForm').reset();
  $('kanbanCardError').textContent = '';
  $('kanbanNewCheckItem').value = '';

  const fallbackColId =
    defaultColumnId ||
    kanbanState.kanban.columns[selectedKanbanColIndex]?.id ||
    kanbanState.kanban.columns[0]?.id;

  if (card) {
    $('kanbanCardDialogTitle').textContent = 'Edytuj zadanie';
    $('kanbanCardTitleInput').value = card.title;
    $('kanbanCardPriority').value = card.priority || 'medium';
    $('kanbanCardDueDate').value = card.dueDate || '';
    $('kanbanCardDesc').value = card.description || '';
    populateKanbanCardFormSelects(card.subjectName || '', card.category ?? '', card.columnId);
    draftChecklist = clone(card.checklist || []);
    $('deleteKanbanCardBtn').hidden = false;
  } else {
    $('kanbanCardDialogTitle').textContent = 'Dodaj zadanie';
    $('kanbanCardPriority').value = 'medium';
    $('kanbanCardDueDate').value = '';
    $('kanbanCardDesc').value = '';
    const activeFilterSubj = $('kanbanFilterSubject')?.value || '';
    const initialSubj = activeFilterSubj && activeFilterSubj !== '__none__' ? activeFilterSubj : '';
    populateKanbanCardFormSelects(initialSubj, 'Projekt', fallbackColId);
    draftChecklist = [];
    $('deleteKanbanCardBtn').hidden = true;
  }

  renderDraftChecklist();
  showDialogModal($('kanbanCardDialog'));
}

function saveKanbanCard(event) {
  event.preventDefault();
  try {
    // Jeśli użytkownik wpisał tekst podzadania i od razu kliknął „Zapisz zadanie”, dołączamy je
    const pendingCheck = $('kanbanNewCheckItem').value.trim();
    if (pendingCheck && draftChecklist.length < 50) {
      draftChecklist.push({ id: uid(), text: pendingCheck, done: false });
      $('kanbanNewCheckItem').value = '';
    }

    const title = $('kanbanCardTitleInput').value.trim();
    if (!title) throw Error('Podaj tytuł zadania.');

    const columnId = $('kanbanCardColumn').value;
    const priority = $('kanbanCardPriority').value;
    const dueDate = $('kanbanCardDueDate').value.trim();
    const description = $('kanbanCardDesc').value.trim();

    const subjVal = $('kanbanCardSubjectSelect').value;
    const subjectName =
      subjVal === KANBAN_CUSTOM_SUBJECT ? $('kanbanCardSubjectCustom').value.trim() : subjVal.trim();

    const catVal = $('kanbanCardCategorySelect').value;
    const category =
      catVal === KANBAN_CUSTOM_CATEGORY ? $('kanbanCardCategoryCustom').value.trim() : catVal.trim();

    const checklist = draftChecklist
      .map((item) => ({ id: item.id || uid(), text: item.text.trim(), done: !!item.done }))
      .filter((item) => item.text.length > 0);

    mutateKanban((kanban) => {
      if (editingKanbanCardId) {
        const existing = kanban.cards.find((c) => c.id === editingKanbanCardId);
        if (!existing) return;
        const colChanged = existing.columnId !== columnId;
        existing.title = title;
        existing.columnId = columnId;
        existing.priority = priority;
        existing.dueDate = dueDate;
        existing.description = description;
        existing.subjectName = subjectName;
        existing.category = category;
        existing.checklist = checklist;
        if (colChanged) {
          const sameCol = kanban.cards.filter((c) => c.columnId === columnId && c.id !== existing.id);
          existing.order = sameCol.length;
        }
      } else {
        const sameCol = kanban.cards.filter((c) => c.columnId === columnId);
        kanban.cards.push({
          id: uid(),
          columnId,
          title,
          description,
          subjectName,
          category,
          priority,
          dueDate,
          checklist,
          order: sameCol.length,
        });
      }
    });

    $('kanbanCardDialog').close();
  } catch (err) {
    $('kanbanCardError').textContent = err.message;
  }
}

function deleteKanbanCard() {
  if (!editingKanbanCardId) return;
  if (!confirm('Czy na pewno usunąć to zadanie z tablicy Kanban?')) return;
  try {
    mutateKanban((kanban) => {
      kanban.cards = kanban.cards.filter((c) => c.id !== editingKanbanCardId);
    });
    $('kanbanCardDialog').close();
  } catch (err) {
    $('kanbanCardError').textContent = err.message;
  }
}

// --- Zarządzanie kolumnami i czyszczenie tablicy Kanban ----------------------

function renderKanbanColumnsList() {
  const container = $('kanbanColumnsList');
  container.replaceChildren();

  const cols = kanbanState.kanban.columns;
  cols.forEach((col, idx) => {
    const count = kanbanState.kanban.cards.filter((c) => c.columnId === col.id).length;
    const row = node('div', 'seriesrow');

    const input = document.createElement('input');
    input.type = 'text';
    input.value = col.title;
    input.maxLength = 60;
    input.ariaLabel = 'Nazwa kolumny';
    input.onchange = () => {
      const nextTitle = input.value.trim();
      if (!nextTitle) {
        input.value = col.title;
        return;
      }
      try {
        mutateKanban((kanban) => {
          const target = kanban.columns.find((c) => c.id === col.id);
          if (target) target.title = nextTitle;
        });
        renderKanbanColumnsList();
      } catch (err) {
        $('kanbanColumnsError').textContent = err.message;
      }
    };

    const actions = node('div', 'actions');

    if (idx > 0) {
      const upBtn = node('button', 'kanban-icon-btn');
      upBtn.type = 'button';
      upBtn.title = 'Przesuń w lewo / wyżej';
      upBtn.innerHTML = '<i class="ph ph-arrow-up"></i>';
      upBtn.onclick = () => {
        mutateKanban((kanban) => {
          const temp = kanban.columns[idx - 1];
          kanban.columns[idx - 1] = kanban.columns[idx];
          kanban.columns[idx] = temp;
        });
        renderKanbanColumnsList();
      };
      actions.append(upBtn);
    }

    if (idx < cols.length - 1) {
      const downBtn = node('button', 'kanban-icon-btn');
      downBtn.type = 'button';
      downBtn.title = 'Przesuń w prawo / niżej';
      downBtn.innerHTML = '<i class="ph ph-arrow-down"></i>';
      downBtn.onclick = () => {
        mutateKanban((kanban) => {
          const temp = kanban.columns[idx + 1];
          kanban.columns[idx + 1] = kanban.columns[idx];
          kanban.columns[idx] = temp;
        });
        renderKanbanColumnsList();
      };
      actions.append(downBtn);
    }

    const delBtn = node('button', 'danger', count > 0 ? `Zajęta (${count})` : 'Usuń');
    delBtn.type = 'button';
    delBtn.disabled = cols.length <= 1 || count > 0;
    delBtn.onclick = () => {
      try {
        mutateKanban((kanban) => {
          kanban.columns = kanban.columns.filter((c) => c.id !== col.id);
        });
        renderKanbanColumnsList();
      } catch (err) {
        $('kanbanColumnsError').textContent = err.message;
      }
    };
    actions.append(delBtn);

    row.append(input, actions);
    container.append(row);
  });
}

function openKanbanColumnsDialog() {
  $('kanbanColumnsError').textContent = '';
  $('newKanbanColumnTitle').value = '';
  renderKanbanColumnsList();
  showDialogModal($('kanbanColumnsDialog'));
}

function addKanbanColumn(event) {
  event.preventDefault();
  try {
    const title = $('newKanbanColumnTitle').value.trim();
    if (!title) return;
    mutateKanban((kanban) => {
      if (kanban.columns.length >= 12) {
        throw Error('Maksymalnie 12 kolumn w tablicy Kanban.');
      }
      kanban.columns.push({ id: uid(), title });
    });
    $('newKanbanColumnTitle').value = '';
    $('kanbanColumnsError').textContent = '';
    renderKanbanColumnsList();
  } catch (err) {
    $('kanbanColumnsError').textContent = err.message;
  }
}

function clearKanbanDone() {
  const cols = kanbanState.kanban.columns;
  if (!cols.length) return;
  const doneCol = cols[cols.length - 1];
  const doneCards = kanbanState.kanban.cards.filter((c) => c.columnId === doneCol.id);
  if (!doneCards.length) {
    setStatus(`W kolumnie „${doneCol.title}” nie ma żadnych ukończonych zadań do usunięcia.`);
    return;
  }
  if (
    !confirm(
      `Usunąć wszystkie zadania (${doneCards.length}) z kolumny „${doneCol.title}”?`,
    )
  ) {
    return;
  }
  mutateKanban((kanban) => {
    kanban.cards = kanban.cards.filter((c) => c.columnId !== doneCol.id);
  });
  setStatus(`Usunięto ${doneCards.length} ukończonych zadań z kolumny „${doneCol.title}”.`);
}

function resetKanbanBoard() {
  if (
    !confirm(
      'Czy na pewno wyczyścić całą tablicę Kanban do domyślnych 3 kolumn i usunąć wszystkie zadania?',
    )
  ) {
    return;
  }
  mutateKanban((kanban) => {
    Object.assign(kanban, emptyKanban());
  });
  setStatus('Tablica Kanban została zresetowana. Kliknij „Zapisz tablicę w chmurze”, jeśli chcesz nadpisać też plik kanban.json w chmurze.');
}

// --- Nawigacja po tygodniach -------------------------------------------------

function showWeek(newWeek) {
  week = newWeek;
  render();
}

// --- Import / eksport (osobny plik dla Planu i osobny dla tablicy Kanban) ---

function exportActiveView() {
  const isKanban = activeView === 'kanban';
  const payload = isKanban ? kanbanState.kanban : state.plan;
  const customBase = isKanban ? getActiveKanbanId() : getActivePlanId();
  const baseName = customBase || (isKanban ? 'kanban' : 'plan');
  const filename = `${baseName}-${today()}.json`;

  const json = JSON.stringify(payload, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));

  const link = node('a');
  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importActiveView() {
  const input = $('import');
  const file = input.files[0];
  try {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw Error('Maksymalny rozmiar pliku to 2 MB.');

    const parsed = JSON.parse(await file.text());

    // Automatyczne rozpoznanie, czy użytkownik wgrywa plik tablicy Kanban czy plik planu zajęć
    const looksLikeKanban = Array.isArray(parsed?.columns) && Array.isArray(parsed?.cards);

    if (looksLikeKanban || activeView === 'kanban') {
      const kanban = validateKanban(parsed);
      if (
        !confirm(
          'Zastąpić lokalną tablicę Kanban danymi z pliku JSON? W razie potrzeby najpierw wyeksportuj obecną kopię.',
        )
      ) {
        return;
      }
      if (activeView !== 'kanban') setActiveView('kanban');
      mutateKanban((current) => Object.assign(current, kanban));
      setStatus('Zaimportowano tablicę Kanban z pliku JSON.');
    } else {
      const plan = validatePlan(parsed);
      if (
        !confirm(
          'Zastąpić lokalny plan zajęć danymi z pliku JSON? W razie potrzeby najpierw wyeksportuj obecną kopię.',
        )
      ) {
        return;
      }
      if (activeView !== 'calendar') setActiveView('calendar');
      mutate((current) => Object.assign(current, plan));
      setStatus('Zaimportowano plan zajęć z pliku JSON.');
    }
  } catch (err) {
    setStatus(err instanceof SyntaxError ? 'Plik nie jest prawidłowym JSON-em.' : err.message);
  } finally {
    input.value = '';
  }
}

// --- Klucz dostępu i synchronizacja z chmurą ---------------------------------

function getActivePlanId() {
  try {
    return (localStorage.getItem(PLAN_ID_KEY) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function getActiveKanbanId() {
  try {
    return (localStorage.getItem(KANBAN_ID_KEY) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function updateConnectionPreviews() {
  const rawPlan = ($('planId')?.value || '').trim().toLowerCase();
  const rawKanban = ($('kanbanId')?.value || '').trim().toLowerCase();

  try {
    const planKey = resolvePlanKey(rawPlan);
    $('planKeyPreview').innerHTML = `Plik w chmurze: <code>${planKey}</code>`;
  } catch {
    $('planKeyPreview').textContent = 'Dozwolone tylko litery bez polskich znaków, cyfry, - i _';
  }

  try {
    const kanbanKey = resolveKanbanKey(rawKanban);
    $('kanbanKeyPreview').innerHTML = `Plik w chmurze: <code>${kanbanKey}</code>`;
  } catch {
    $('kanbanKeyPreview').textContent = 'Dozwolone tylko litery bez polskich znaków, cyfry, - i _';
  }
}

function updateConnectionButtonLabel() {
  const btn = $('connection');
  if (!btn) return;
  const isKanban = activeView === 'kanban';
  const id = isKanban ? getActiveKanbanId() : getActivePlanId();
  const defaultFile = isKanban ? 'kanban.json' : 'plan.json';
  btn.innerHTML = '<i class="ph ph-key"></i> ';
  btn.append(document.createTextNode(id ? `Chmura (${id}.json)` : `Chmura (${defaultFile})`));
}

function openConnectionDialog() {
  try {
    $('planId').value = getActivePlanId();
    $('kanbanId').value = getActiveKanbanId();
    $('token').value = localStorage.getItem(TOKEN_KEY) || '';
    $('connectionError').textContent = '';
    updateConnectionPreviews();
    showDialogModal($('connectionDialog'));
  } catch (err) {
    setStatus(err.message);
  }
}

function saveConnection(event) {
  event.preventDefault();
  try {
    const rawPlanId = $('planId').value.trim().toLowerCase();
    const rawKanbanId = $('kanbanId').value.trim().toLowerCase();

    // Walidacja formatu nazwy/ID osobno dla planu i osobno dla tablicy Kanban
    const planKey = resolvePlanKey(rawPlanId);
    const kanbanKey = resolveKanbanKey(rawKanbanId);

    const token = $('token').value.trim();
    if (token && token.length < MIN_TOKEN_LENGTH) {
      throw Error(`Klucz musi mieć minimum ${MIN_TOKEN_LENGTH} znaki.`);
    }

    const prevPlanId = getActivePlanId();
    const prevKanbanId = getActiveKanbanId();

    if (rawPlanId) localStorage.setItem(PLAN_ID_KEY, rawPlanId);
    else localStorage.removeItem(PLAN_ID_KEY);

    if (rawKanbanId) localStorage.setItem(KANBAN_ID_KEY, rawKanbanId);
    else localStorage.removeItem(KANBAN_ID_KEY);

    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);

    if (rawPlanId !== prevPlanId) {
      const next = clone(state);
      next.etag = null;
      persist(next);
    }

    if (rawKanbanId !== prevKanbanId) {
      const nextKanban = clone(kanbanState);
      nextKanban.etag = null;
      persistKanban(nextKanban);
    }

    updateConnectionButtonLabel();
    $('connectionError').textContent = '';
    $('connectionDialog').close();
    setStatus(
      `Zapisano ustawienia chmury (plan: ${planKey} · tablica Kanban: ${kanbanKey}).`,
    );
  } catch (err) {
    $('connectionError').textContent = err.message;
  }
}

function setButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('button')) button.disabled = disabled;
}

/** Wysyła żądanie do Workera (/api/plan lub /api/kanban). direction: 'pull' (GET) lub 'push' (PUT). */
async function callApi(direction, token, planId, target = 'plan', overrideEtag = undefined) {
  const isKanban = target === 'kanban';
  const baseUrl = isKanban ? KANBAN_API_URL : API_URL;
  const url = planId ? `${baseUrl}?id=${encodeURIComponent(planId)}` : baseUrl;
  const headers = { Authorization: 'Bearer ' + token };
  const options = { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(API_TIMEOUT_MS) };

  const currentObj = isKanban ? kanbanState.kanban : state.plan;
  const currentEtag = isKanban ? kanbanState.etag : state.etag;

  if (direction === 'push') {
    options.method = 'PUT';
    options.body = JSON.stringify(currentObj);
    headers['Content-Type'] = 'application/json';
    const etagToUse = overrideEtag !== undefined ? overrideEtag : currentEtag;
    if (etagToUse) headers['If-Match'] = `"${etagToUse}"`;
    else headers['If-None-Match'] = '*';
  }

  const response = await fetch(url, options);

  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('API nie jest dostępne. Uruchom projekt przez npm run dev albo wdróż Worker.');
  }

  if (direction === 'push' && response.status === 409 && overrideEtag === undefined) {
    const label = planId || 'domyślny';
    const resourceName = isKanban ? 'tablicy Kanban' : 'planu';
    if (
      confirm(
        `W chmurze dla ${resourceName} „${label}” znajduje się już inna zapisana wersja. Czy chcesz ją nadpisać swoją obecną wersją lokalną?`,
      )
    ) {
      const remote = await callApi('pull', token, planId, target);
      return callApi('push', token, planId, target, remote.etag);
    }
  }

  if (!response.ok) throw Error(data.error || 'Błąd połączenia.');
  return data;
}

async function sync(direction) {
  if (busy) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      openConnectionDialog();
      return;
    }
    const isKanban = activeView === 'kanban';
    const target = isKanban ? 'kanban' : 'plan';
    const activeId = isKanban ? getActiveKanbanId() : getActivePlanId();
    const fileKey = isKanban ? resolveKanbanKey(activeId) : resolvePlanKey(activeId);
    const isDirty = isKanban ? kanbanState.dirty : state.dirty;
    const nounAcc = isKanban ? 'tablicę Kanban' : 'plan';

    if (
      direction === 'pull' &&
      isDirty &&
      !confirm(
        `Pobranie zastąpi niezapisane lokalne zmiany (${nounAcc}). Wyeksportuj je najpierw do pliku JSON, jeśli chcesz je zachować. Kontynuować?`,
      )
    ) {
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setStatus(
      direction === 'pull'
        ? `Pobieranie z chmury: ${fileKey}…`
        : `Zapisywanie w chmurze: ${fileKey}…`,
    );

    const data = await callApi(direction, token, activeId, target);

    if (isKanban) {
      const next = clone(kanbanState);
      if (direction === 'pull') next.kanban = validateKanban(data.kanban);
      next.etag = data.etag;
      next.dirty = false;
      persistKanban(next);
      renderKanban();
      setStatus(`Zsynchronizowano tablicę Kanban (${fileKey}) · ${new Date().toLocaleTimeString('pl-PL')}.`);
    } else {
      const next = clone(state);
      if (direction === 'pull') next.plan = validatePlan(data.plan);
      next.etag = data.etag;
      next.dirty = false;
      persist(next);
      render();
      setStatus(`Zsynchronizowano plan (${fileKey}) · ${new Date().toLocaleTimeString('pl-PL')}.`);
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      setStatus('Przekroczono czas połączenia. Dane lokalne pozostały bez zmian.');
    } else {
      setStatus(err.message + ' Lokalna kopia pozostaje dostępna.');
    }
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

// --- Podpięcie zdarzeń -------------------------------------------------------

function bindEvents() {
  $('tabCalendar').onclick = () => setActiveView('calendar');
  $('tabKanban').onclick = () => setActiveView('kanban');

  $('menuToggle').onclick = () => {
    const isOpen = $('navPanel').classList.contains('open');
    setMobileMenuOpen(!isOpen);
  };
  $('editModeToggle').onclick = () => setEditMode(!editMode);
  $('addEvent').onclick = () => openEventDialog(null, addDays(week, selectedDayIndex));

  // Zdarzenia tablicy Kanban
  $('addKanbanCardBtn').onclick = () => openKanbanCardDialog();
  $('manageKanbanColsBtn').onclick = () => openKanbanColumnsDialog();
  $('clearKanbanDoneBtn').onclick = () => {
    setMobileMenuOpen(false);
    clearKanbanDone();
  };
  $('resetKanbanBtn').onclick = () => {
    setMobileMenuOpen(false);
    resetKanbanBoard();
  };
  $('kanbanFilterSubject').onchange = renderKanban;
  $('kanbanFilterPriority').onchange = renderKanban;
  $('kanbanSearch').oninput = renderKanban;

  $('kanbanCardSubjectSelect').onchange = updateKanbanSubjectSelectFields;
  $('kanbanCardCategorySelect').onchange = updateKanbanCategorySelectFields;
  $('addKanbanCheckItemBtn').onclick = addDraftChecklistItem;
  $('kanbanNewCheckItem').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDraftChecklistItem();
    }
  });
  $('kanbanCardForm').onsubmit = saveKanbanCard;
  $('deleteKanbanCardBtn').onclick = deleteKanbanCard;
  $('kanbanColumnForm').onsubmit = addKanbanColumn;
  $('kanbanDetailsEditBtn').onclick = () => {
    const id = detailsKanbanCardId;
    $('kanbanDetailsDialog').close();
    if (id) openKanbanCardDialog(id);
  };

  // Przełączanie kolumn Kanban gestem swipe na telefonie
  let kanbanTouchX = null;
  let kanbanTouchY = null;
  const kanbanBoardEl = $('kanbanBoard');
  kanbanBoardEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1 && window.innerWidth <= 768) {
        kanbanTouchX = e.touches[0].clientX;
        kanbanTouchY = e.touches[0].clientY;
      }
    },
    { passive: true },
  );
  kanbanBoardEl.addEventListener(
    'touchend',
    (e) => {
      if (kanbanTouchX === null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - kanbanTouchX;
      const dy = e.changedTouches[0].clientY - kanbanTouchY;
      kanbanTouchX = null;
      kanbanTouchY = null;
      const totalCols = kanbanState.kanban.columns.length;
      if (window.innerWidth <= 768 && totalCols > 1 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0 && selectedKanbanColIndex < totalCols - 1) {
          kanbanMobileSlideDir = 'slide-next';
          selectedKanbanColIndex++;
          renderKanban();
        } else if (dx > 0 && selectedKanbanColIndex > 0) {
          kanbanMobileSlideDir = 'slide-prev';
          selectedKanbanColIndex--;
          renderKanban();
        }
      }
    },
    { passive: true },
  );
  $('subject').onchange = updateSubjectSelectionFields;
  $('typeSelect').onchange = updateTypeSelectFields;
  $('start').onchange = () => {
    const startVal = $('start').value;
    if (!startVal) return;
    const isCustom = $('subject').value === CUSTOM_SUBJECT_VALUE;
    const endVal = $('end').value;
    if (!endVal || endVal <= startVal) {
      const duration = isCustom ? 60 : 90;
      $('end').value = fromMinutes(Math.min(23 * 60 + 55, toMinutes(startVal) + duration));
    }
  };
  $('eventForm').onsubmit = saveEvent;
  $('deleteEvent').onclick = deleteEvent;
  $('repeat').onchange = updateRepeatFields;

  $('detailsEditEventBtn').onclick = () => {
    const id = detailsEventId;
    $('eventDetailsDialog').close();
    if (id) openEventDialog(id);
  };

  $('detailsEditSubjectBtn').onclick = () => {
    const ev = state.plan.events.find((e) => e.id === detailsEventId);
    const subj = state.plan.subjects.find((s) => s.id === ev?.subjectId);
    $('eventDetailsDialog').close();
    openSubjectDialog('', subj || null);
  };

  $('subjects').onclick = () => {
    setMobileMenuOpen(false);
    openSubjectDialog();
  };
  $('subjectForm').onsubmit = saveSubject;
  $('newSubject').onclick = resetSubjectForm;

  $('bulkManageBtn').onclick = () => {
    setMobileMenuOpen(false);
    openBulkDialog();
  };
  $('reconcileBtn').onclick = runReconcile;
  $('clearEventsBtn').onclick = clearAllEvents;
  $('clearAllBtn').onclick = clearEntireCalendar;

  $('academicYearBtn').onclick = () => {
    setMobileMenuOpen(false);
    openAcademicYearDialog();
  };
  $('academicYearForm').onsubmit = saveSpecialDay;
  $('specialDayType').onchange = updateSpecialDayTypeFields;
  $('rectorFullDay').onchange = updateSpecialDayTypeFields;

  for (const button of document.querySelectorAll('[data-close]')) {
    button.onclick = () => button.closest('dialog').close();
  }

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', syncModalScrollLock);
    dialog.addEventListener('cancel', () => setTimeout(syncModalScrollLock, 0));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  $('prev').onclick = () => showWeek(addDays(week, -7));
  $('next').onclick = () => showWeek(addDays(week, 7));
  $('today').onclick = () => {
    const t = today();
    selectedDayIndex = weekdayIndex(t);
    showWeek(monday(t));
  };
  $('jump').onchange = () => {
    const val = $('jump').value;
    if (val) {
      selectedDayIndex = weekdayIndex(val);
      showWeek(monday(val));
    }
  };

  // Przełączanie dni gestem przesunięcia palcem (swipe lewo/prawo) na telefonie
  let touchStartX = null;
  let touchStartY = null;
  let isHorizontalSwipe = null;
  const calendarEl = $('calendar');

  const resetActiveDayDrag = () => {
    const activeDay = calendarEl.querySelector('.day.mobile-active');
    if (activeDay) {
      activeDay.style.transform = '';
      activeDay.style.opacity = '';
      activeDay.style.transition = '';
    }
  };

  calendarEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1 && window.innerWidth <= 768) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        isHorizontalSwipe = null;
      }
    },
    { passive: true },
  );
  calendarEl.addEventListener(
    'touchmove',
    (e) => {
      if (touchStartX === null || e.touches.length !== 1 || window.innerWidth > 768) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;

      if (isHorizontalSwipe === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.3;
      }

      if (isHorizontalSwipe) {
        const activeDay = calendarEl.querySelector('.day.mobile-active');
        if (activeDay) {
          const dampedX = Math.max(-90, Math.min(90, dx * 0.38));
          const progress = Math.min(1, Math.abs(dx) / 220);
          activeDay.style.transition = 'none';
          activeDay.style.transform = `translate3d(${dampedX.toFixed(1)}px, 0, 0)`;
          activeDay.style.opacity = String((1 - progress * 0.25).toFixed(2));
        }
      }
    },
    { passive: true },
  );
  calendarEl.addEventListener('touchcancel', () => {
    touchStartX = null;
    touchStartY = null;
    isHorizontalSwipe = null;
    resetActiveDayDrag();
  });
  calendarEl.addEventListener(
    'touchend',
    (e) => {
      if (touchStartX === null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;
      isHorizontalSwipe = null;

      if (window.innerWidth <= 768 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0) {
          // Przesunięcie w lewo → następny dzień
          mobileSlideDir = 'slide-next';
          if (selectedDayIndex < 6) {
            selectedDayIndex++;
            render();
          } else {
            selectedDayIndex = 0;
            showWeek(addDays(week, 7));
          }
        } else {
          // Przesunięcie w prawo → poprzedni dzień
          mobileSlideDir = 'slide-prev';
          if (selectedDayIndex > 0) {
            selectedDayIndex--;
            render();
          } else {
            selectedDayIndex = 6;
            showWeek(addDays(week, -7));
          }
        }
      } else {
        resetActiveDayDrag();
      }
    },
    { passive: true },
  );

  // Odświeżanie na żywo paska aktualnej godziny (bez przeładowywania strony)
  setInterval(updateLiveTimeIndicator, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateLiveTimeIndicator();
  });
  window.addEventListener('resize', () => {
    requestAnimationFrame(refreshSpecialDayMarquees);
  });

  $('export').onclick = () => {
    setMobileMenuOpen(false);
    exportActiveView();
  };
  $('importButton').onclick = () => {
    setMobileMenuOpen(false);
    $('import').click();
  };
  $('import').onchange = importActiveView;

  $('connection').onclick = () => {
    setMobileMenuOpen(false);
    openConnectionDialog();
  };
  $('planId').oninput = updateConnectionPreviews;
  $('kanbanId').oninput = updateConnectionPreviews;
  $('connectionForm').onsubmit = saveConnection;
  $('pull').onclick = () => sync('pull');
  $('push').onclick = () => sync('push');

  // Inna karta tej samej przeglądarki zmieniła dane — blokujemy edycję, żeby się nie nadpisywać.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === KANBAN_STORAGE_KEY || e.key === null) {
      storageBlocked = true;
      setStatus('Inna karta zmieniła dane. Wyeksportuj swoją kopię i odśwież stronę przed dalszą edycją.');
    }
  });
}

// --- Start -------------------------------------------------------------------

loadFromStorage();
bindEvents();
updateConnectionButtonLabel();
renderKanbanBadge();
setEditMode(false);
reportState();
