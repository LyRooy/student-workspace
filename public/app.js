// Logika interfejsu: Plan zajęć, Tablica Kanban, tryb przeglądania i edycji,
// zapis lokalny (localStorage) oraz synchronizacja z Workerem Cloudflare (/api/plan, /api/kanban).

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
const AUTO_SYNC_KEY = 'student-calendar-auto-sync';
const API_URL = '/api/plan';
const KANBAN_API_URL = '/api/kanban';
const API_TIMEOUT_MS = 20_000;
const AUTO_SAVE_DELAY_MS = 1200;
const AUTO_PULL_COOLDOWN_MS = 2_500;
const AUTO_PULL_INTERVAL_MS = 5_000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Ndz'];
const MOBILE_DAY_CODES = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SB', 'ND'];
const DAY_KEY_NAMES = {
  mon: 'poniedziałku',
  tue: 'wtorku',
  wed: 'środy',
  thu: 'czwartku',
  fri: 'piątku',
  sat: 'soboty',
  sun: 'niedzieli',
};

const SLOT_MINUTES = 5;
const SLOT_HEIGHT_PX = 15; // 5 min = 15px
const DEFAULT_START_MIN = 8 * 60;
const DEFAULT_END_MIN = 16 * 60;
const CUSTOM_SUBJECT_VALUE = '__custom__';
const CUSTOM_TYPE_VALUE = '__custom__';
const KANBAN_CUSTOM_SUBJECT = '__custom_subject__';
const KANBAN_CUSTOM_CATEGORY = '__custom__';
const EVENT_FIELDS = ['start', 'end', 'room', 'teacher', 'notes'];
const PRIORITY_LABELS = { high: 'Wysoki', medium: 'Średni', low: 'Niski' };
const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 };

const TYPE_VISUAL_RULES = [
  [['poprawk', 'komis'], 'type-retake', 'ph-arrow-counter-clockwise'],
  [['egzamin'], 'type-exam', 'ph-scroll'],
  [['kolokwium', 'zaliczeni', 'wejściów', 'test'], 'type-test', 'ph-check-square-offset'],
  [['obrona', 'dyplom'], 'type-defense', 'ph-graduation-cap'],
  [['wykład', 'wyklad'], 'type-lecture', 'ph-chalkboard-teacher'],
  [['lab'], 'type-lab', 'ph-flask'],
  [['projekt'], 'type-project', 'ph-kanban'],
  [['ćwicz', 'cwicz', 'lektorat', 'wf'], 'type-exercise', 'ph-pencil-line'],
  [['seminarium'], 'type-seminar', 'ph-chats-circle'],
  [['konsultac', 'promotor', 'spotkanie'], 'type-consult', 'ph-user-focus'],
  [['odrabianie'], 'type-makeup', 'ph-clock-clockwise'],
  [['lekarz', 'dentyst', 'prywatn', 'badani'], 'type-other', 'ph-first-aid-kit'],
  [['warsztat', 'szkoleni', 'kurs', 'trening'], 'type-exercise', 'ph-wrench'],
  [['koło', 'kolo', 'zebranie', 'rada'], 'type-consult', 'ph-users-three'],
];

const weekdayIndex = (date) => (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;

let state = { plan: emptyPlan(), etag: null, dirty: false };
let lastStored = null;
let kanbanState = { kanban: emptyKanban(), etag: null, dirty: false };
let lastStoredKanban = null;
let activeView = 'calendar'; // 'calendar' | 'kanban'
let storageBlocked = false;
let busy = false;
let editMode = false;
let editingId = null;
let detailsEventId = null;
let editingKanbanCardId = null;
let detailsKanbanCardId = null;
let draftChecklist = [];
let selectedKanbanColIndex = 0;
let kanbanMobileSlideDir = '';
let draggedKanbanCardId = null;
let week = monday(today());
let selectedDayIndex = weekdayIndex(today());
let mobileSlideDir = '';
let currentGridBounds = { startMin: DEFAULT_START_MIN, endMin: DEFAULT_END_MIN };
let lastRenderedToday = today();
let lockedScrollY = 0;
let isScrollLocked = false;
let planAutoSaveTimer = null;
let kanbanAutoSaveTimer = null;
let autoSyncInFlight = 0;
let autoPullInFlight = false;
let cloudSyncState = 'unconfigured'; // 'unconfigured' | 'synced' | 'pending' | 'dirty' | 'error'
let cloudSyncDetail = '';
let lastAutoPullAt = 0;

const TARGETS = {
  plan: {
    storageKey: STORAGE_KEY,
    idKey: PLAN_ID_KEY,
    apiUrl: API_URL,
    prop: 'plan',
    validate: validatePlan,
    resolveKey: resolvePlanKey,
    blockedMsg: 'Zapis lokalny jest zablokowany. Wyeksportuj plan przed przeładowaniem strony.',
    otherTabMsg: 'Inna karta zmieniła plan. Wyeksportuj swoją kopię i odśwież stronę.',
    nounGen: 'planu',
    nounAcc: 'plan',
    label: 'plan zajęć',
    hasData: (p) => p.events.length > 0 || p.subjects.length > 0 || (p.academicYear?.specialDays?.length || 0) > 0,
    getState: () => state,
    setState: (s) => { state = s; },
    getLastStored: () => lastStored,
    setLastStored: (v) => { lastStored = v; },
    getTimer: () => planAutoSaveTimer,
    setTimer: (t) => { planAutoSaveTimer = t; },
    onAfterChange: () => { render(); renderKanbanBadge(); if (activeView === 'kanban') renderKanban(); },
    onAfterPull: () => {
      render();
      renderKanbanBadge();
      if (activeView === 'kanban') renderKanban();
      if ($('eventDetailsDialog')?.open && detailsEventId) {
        if (state.plan.events.some((e) => e.id === detailsEventId)) openEventDetailsDialog(detailsEventId);
        else $('eventDetailsDialog').close();
      }
    },
  },
  kanban: {
    storageKey: KANBAN_STORAGE_KEY,
    idKey: KANBAN_ID_KEY,
    apiUrl: KANBAN_API_URL,
    prop: 'kanban',
    validate: validateKanban,
    resolveKey: resolveKanbanKey,
    blockedMsg: 'Zapis lokalny jest zablokowany. Wyeksportuj tablicę Kanban przed przeładowaniem strony.',
    otherTabMsg: 'Inna karta zmieniła tablicę Kanban. Wyeksportuj swoją kopię i odśwież stronę.',
    nounGen: 'tablicy Kanban',
    nounAcc: 'tablicę Kanban',
    label: 'tablicę Kanban',
    hasData: (k) => k.cards.length > 0,
    getState: () => kanbanState,
    setState: (s) => { kanbanState = s; },
    getLastStored: () => lastStoredKanban,
    setLastStored: (v) => { lastStoredKanban = v; },
    getTimer: () => kanbanAutoSaveTimer,
    setTimer: (t) => { kanbanAutoSaveTimer = t; },
    onAfterChange: () => renderKanban(),
    onAfterPull: () => {
      renderKanban();
      if ($('kanbanDetailsDialog')?.open && detailsKanbanCardId) {
        if (kanbanState.kanban.cards.some((c) => c.id === detailsKanbanCardId)) openKanbanDetailsDialog(detailsKanbanCardId);
        else $('kanbanDetailsDialog').close();
      }
    },
  },
};

// --- Narzędzia ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const slotTier = (m) => (m % 60 === 0 ? 'hour' : m % 15 === 0 ? 'quarter' : 'five');

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function nowMinutesFloat() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function nowTimeLabel() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function fromMinutes(total) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} godz. ${m} min`;
  return h > 0 ? `${h} godz.` : `${m} min`;
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function iconBtn(className, iconClass, title, onClick, text) {
  const btn = node('button', className);
  btn.type = 'button';
  if (title) {
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  btn.innerHTML = `<i class="ph ${iconClass}"></i>`;
  if (text) btn.append(document.createTextNode(' ' + text));
  if (onClick) btn.onclick = onClick;
  return btn;
}

function iconTag(className, iconClass, text) {
  const el = node('span', className);
  el.innerHTML = `<i class="ph ${iconClass}"></i>`;
  el.append(node('span', '', text));
  return el;
}

function syncModalScrollLock() {
  const open = Boolean(document.querySelector('dialog[open]'));
  if (open && !isScrollLocked) {
    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    isScrollLocked = true;
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    document.body.style.top = `-${lockedScrollY}px`;
  } else if (!open && isScrollLocked) {
    isScrollLocked = false;
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }
}

function showDialogModal(dialogEl) {
  if (!dialogEl.open) dialogEl.showModal();
  syncModalScrollLock();
}

const URL_REGEX = /(https?:\/\/[^\s<>"')]+)/gi;

async function copyTextWithFeedback(text, btnEl, defaultLabel = null) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (!btnEl) return;
    const prevHtml = btnEl.innerHTML;
    btnEl.classList.add('copied');
    btnEl.innerHTML = defaultLabel ? '<i class="ph ph-check"></i> <span>Skopiowano!</span>' : '<i class="ph ph-check"></i>';
    setTimeout(() => {
      btnEl.classList.remove('copied');
      btnEl.innerHTML = prevHtml;
    }, 1500);
  } catch {
    setStatus('Nie udało się automatycznie skopiować do schowka.');
  }
}

/** Zamienia adresy URL (http/https) w tekście na klikalne odnośniki z przyciskiem kopiowania. */
function renderRichTextWithLinks(container, rawText) {
  container.replaceChildren();
  const text = rawText || '';
  if (!text) return;

  let lastIdx = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0];
    const startIdx = match.index ?? 0;
    if (startIdx > lastIdx) container.append(document.createTextNode(text.slice(lastIdx, startIdx)));

    const chip = node('span', 'rich-link-chip');
    const link = node('a', 'rich-link');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.draggable = false;
    link.innerHTML = '<i class="ph ph-arrow-square-out"></i>';
    link.append(node('span', 'rich-link-url', url));
    link.onclick = (e) => e.stopPropagation();

    const copyBtn = iconBtn('rich-link-copy', 'ph-copy', 'Kopiuj ten link do schowka', (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyTextWithFeedback(url, copyBtn);
    });
    copyBtn.setAttribute('aria-label', 'Kopiuj link');

    chip.append(link, copyBtn);
    container.append(chip);
    lastIdx = startIdx + url.length;
  }
  if (lastIdx < text.length) container.append(document.createTextNode(text.slice(lastIdx)));
}

const dayMonthFormat = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' });
const shortClockDateFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' });
const fullDateFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const formatDate = (date) => dayMonthFormat.format(new Date(date + 'T12:00:00Z'));
const formatFullDate = (date) => fullDateFormat.format(new Date(date + 'T12:00:00Z'));

// --- Komunikaty i widoki -----------------------------------------------------

const setStatus = (message) => { $('status').textContent = message; };

function reportState() {
  if (storageBlocked) {
    setStatus('Nie można bezpiecznie zapisać danych lokalnych. Wyeksportuj plik JSON i sprawdź pamięć przeglądarki.');
  } else if (activeView === 'kanban') {
    setStatus(
      kanbanState.dirty
        ? 'Masz lokalne zmiany w tablicy Kanban · Kliknij „Zapisz tablicę w chmurze” lub poczekaj na auto-zapis (1,2 s).'
        : 'Tablica Kanban zapisana lokalnie (osobny plik kanban.json) · Pobierz z chmury, aby sprawdzić aktualną wersję.',
    );
  } else {
    setStatus(
      state.dirty
        ? 'Masz lokalne zmiany · Kliknij „Zapisz plan w chmurze” lub poczekaj na auto-zapis (1,2 s).'
        : 'Plan zapisany lokalnie · Pobierz z chmury, aby sprawdzić aktualną wersję.',
    );
  }
  updateCloudStatusIndicator();
}

function closeToolbarDropdowns(except = null) {
  for (const details of document.querySelectorAll('.toolbar-dropdown[open]')) {
    if (details !== except) details.open = false;
  }
}

function updateViewToolbarAndHeader() {
  const isKanban = activeView === 'kanban';
  closeToolbarDropdowns();

  $('tabCalendar').classList.toggle('active', !isKanban);
  $('tabCalendar').setAttribute('aria-selected', String(!isKanban));
  $('tabKanban').classList.toggle('active', isKanban);
  $('tabKanban').setAttribute('aria-selected', String(isKanban));

  $('calendarView').hidden = isKanban;
  $('kanbanView').hidden = !isKanban;
  $('appHeading').innerHTML = isKanban ? 'Tablica Kanban<span>.</span>' : 'Plan zajęć<span>.</span>';

  $('editModeToggle').hidden = false;
  $('addEvent').hidden = isKanban || !editMode;
  $('addKanbanCardBtn').hidden = !isKanban || !editMode;
  $('manageDropdown').hidden = !editMode;
  $('manageDropdownLabel').textContent = isKanban ? 'Zarządzaj tablicą' : 'Zarządzaj planem';

  $('academicYearBtn').hidden = isKanban || !editMode;
  $('bulkManageBtn').hidden = isKanban || !editMode;
  $('manageKanbanColsBtn').hidden = !isKanban || !editMode;
  $('clearKanbanDoneBtn').hidden = !isKanban || !editMode;
  $('resetKanbanBtn').hidden = !isKanban || !editMode;

  $('exportLabel').textContent = 'Eksport (.json)';
  $('importLabel').textContent = 'Import (.json)';
  $('pullLabel').textContent = 'Pobierz z chmury';
  $('pushLabel').textContent = 'Zapisz w chmurze';

  $('export').title = isKanban ? 'Eksportuj tablicę Kanban do pliku .json' : 'Eksportuj plan zajęć do pliku .json';
  $('importButton').title = isKanban ? 'Importuj tablicę Kanban z pliku .json' : 'Importuj plan zajęć z pliku .json';
  $('pull').title = isKanban ? 'Pobierz najnowszą tablicę Kanban z chmury' : 'Pobierz najnowszy plan zajęć z chmury';
  $('push').title = isKanban ? 'Zapisz tablicę Kanban w chmurze' : 'Zapisz plan zajęć w chmurze';
  updateConnectionButtonLabel();
}

function setActiveView(view) {
  activeView = view === 'kanban' ? 'kanban' : 'calendar';
  updateViewToolbarAndHeader();
  if (activeView === 'kanban') renderKanban();
  else render();
  reportState();
}

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
    ? 'Tryb edycji aktywny: dodawaj zadania, edytuj ich treść, zarządzaj kolumnami, odhaczaj podzadania i przeciągaj karty (<code>kanban.json</code>).'
    : 'Kliknij zadanie, aby zobaczyć jego szczegóły. Odhaczanie podzadań i przenoszenie kart między kolumnami działa zawsze — włącz „Tryb edycji”, aby dodawać lub edytować zadania i kolumny.';

  render();
  renderKanban();
}

function setMobileMenuOpen(open) {
  const isOpen = !!open;
  $('navPanel').classList.toggle('open', isOpen);
  const btn = $('menuToggle');
  btn.setAttribute('aria-expanded', String(isOpen));
  btn.innerHTML = isOpen ? '<i class="ph ph-x"></i><span>Zamknij</span>' : '<i class="ph ph-list"></i><span>Menu</span>';
}

// --- Zapis lokalny i mutacje -------------------------------------------------

function loadFromStorage() {
  try {
    for (const key of ['plan', 'kanban']) {
      const cfg = TARGETS[key];
      const raw = localStorage.getItem(cfg.storageKey);
      cfg.setLastStored(raw);
      if (raw) {
        const saved = JSON.parse(raw);
        cfg.validate(saved[cfg.prop]);
        cfg.setState({ [cfg.prop]: saved[cfg.prop], etag: saved.etag ?? null, dirty: !!saved.dirty });
      }
    }
  } catch {
    storageBlocked = true;
  }
}

function persistTarget(target, next) {
  const cfg = TARGETS[target];
  if (storageBlocked) throw Error(cfg.blockedMsg);
  if (localStorage.getItem(cfg.storageKey) !== cfg.getLastStored()) throw Error(cfg.otherTabMsg);

  const encoded = JSON.stringify(next);
  localStorage.setItem(cfg.storageKey, encoded);
  cfg.setLastStored(encoded);
  cfg.setState(next);
}

function mutateTarget(target, change) {
  if (busy) throw Error('Poczekaj na zakończenie synchronizacji.');
  const cfg = TARGETS[target];
  const next = clone(cfg.getState());
  change(next[cfg.prop]);
  cfg.validate(next[cfg.prop]);
  next.dirty = true;

  persistTarget(target, next);
  cfg.onAfterChange();
  reportState();
  scheduleAutoPush(target);
}

const mutate = (change) => mutateTarget('plan', change);
const mutateKanban = (change) => mutateTarget('kanban', change);

// --- Siatka tygodniowa, okienka i godziny rektorskie ------------------------

function getGridBounds(weekEvents, specialDaysInWeek = []) {
  let startMin = DEFAULT_START_MIN;
  let endMin = DEFAULT_END_MIN;
  const expand = (s, e) => {
    startMin = Math.min(startMin, Math.floor(s / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(e / 60) * 60);
  };
  for (const e of weekEvents) expand(toMinutes(e.start), toMinutes(e.end));
  for (const sd of specialDaysInWeek) {
    if (sd?.type === 'rector' && sd.start && sd.end) expand(toMinutes(sd.start), toMinutes(sd.end));
  }
  return { startMin, endMin };
}

function isEventCancelledByRector(event, specialDay) {
  if (specialDay?.type !== 'rector' || !event.subjectId) return false;
  if (!specialDay.start || !specialDay.end) return true;
  return toMinutes(event.start) < toMinutes(specialDay.end) && toMinutes(event.end) > toMinutes(specialDay.start);
}

function describeRectorImpact(dayEvents, specialDay) {
  const classEvents = dayEvents.filter((e) => Boolean(e.subjectId));
  const cancelled = classEvents.filter((e) => isEventCancelledByRector(e, specialDay));
  const active = classEvents.filter((e) => !isEventCancelledByRector(e, specialDay));

  if (!specialDay.start || !specialDay.end) {
    return {
      fullDayFree: true,
      cancelledCount: cancelled.length,
      title: 'Wolny dzień · Dzień rektorski',
      hoursLabel: 'Cały dzień',
      freeSummary: cancelled.length ? `Wszystkie zajęcia (${cancelled.length}) odwołane — cały dzień wolny` : 'Cały dzień wolny od zajęć',
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
  let freeSummary;

  if (before.length && after.length) {
    const from = Math.max(...before.map((e) => toMinutes(e.end)));
    const until = Math.min(...after.map((e) => toMinutes(e.start)));
    freeSummary = `Wolne między zajęciami: ${formatDuration(Math.max(0, until - from))} (${fromMinutes(from)} – ${fromMinutes(until)})`;
  } else if (before.length) {
    const from = Math.max(...before.map((e) => toMinutes(e.end)));
    freeSummary = cancelled.length ? `Końcowe zajęcia przepadają — wolne od ${fromMinutes(from)} do końca dnia` : `Wolne od ${fromMinutes(from)} do końca dnia`;
  } else if (after.length) {
    const until = Math.min(...after.map((e) => toMinutes(e.start)));
    freeSummary = cancelled.length ? `Poranne zajęcia przepadają — wolne do ${fromMinutes(until)}` : `Wolny poranek — zajęcia od ${fromMinutes(until)}`;
  } else {
    freeSummary = `Wolne: ${formatDuration(rEnd - rStart)} (${specialDay.start} – ${specialDay.end})`;
  }

  return { fullDayFree: false, cancelledCount: cancelled.length, title: 'Godziny rektorskie', hoursLabel, freeSummary };
}

function computeGaps(dayEvents) {
  if (dayEvents.length < 2) return [];
  const intervals = dayEvents.map((e) => ({ start: toMinutes(e.start), end: toMinutes(e.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    if (intervals[i].start <= prev.end) prev.end = Math.max(prev.end, intervals[i].end);
    else merged.push({ ...intervals[i] });
  }

  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const durationMin = merged[i + 1].start - merged[i].end;
    if (durationMin > 0) gaps.push({ startMin: merged[i].end, endMin: merged[i + 1].start, durationMin });
  }
  return gaps;
}

function layoutDayEvents(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(b.end) - toMinutes(a.end));
  const clusters = [];
  let current = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    const s = toMinutes(ev.start);
    const e = toMinutes(ev.end);
    if (current.length && s >= clusterEnd) {
      clusters.push(current);
      current = [];
      clusterEnd = -1;
    }
    current.push(ev);
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (current.length) clusters.push(current);

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
    for (const { ev, col } of placement) {
      result.set(ev.id, { col, totalCols: colEnds.length, overlaps: colEnds.length > 1 });
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

  const slots = node('div', 'time-slots');
  slots.style.height = `${((gridEndMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX}px`;

  for (let m = gridStartMin, idx = 0; m < gridEndMin; m += SLOT_MINUTES, idx++) {
    const tier = slotTier(m);
    const label = tier === 'hour' ? fromMinutes(m) : `:${String(m % 60).padStart(2, '0')}`;
    const slotEl = node('div', `time-slot ${tier}`, label);
    slotEl.style.top = `${idx * SLOT_HEIGHT_PX}px`;
    slotEl.style.height = `${SLOT_HEIGHT_PX}px`;
    slots.append(slotEl);
  }
  col.append(slots);
  return col;
}

function buildTimelineGridTemplate(gridStartMin, gridEndMin) {
  const grid = node('div', 'timeline-grid');
  grid.setAttribute('aria-hidden', 'true');
  for (let m = gridStartMin, idx = 0; m < gridEndMin; m += SLOT_MINUTES, idx++) {
    const row = node('div', `timeline-slot ${slotTier(m)}`);
    row.style.top = `${idx * SLOT_HEIGHT_PX}px`;
    row.style.height = `${SLOT_HEIGHT_PX}px`;
    grid.append(row);
  }
  return grid;
}

function renderMobileDayTabs(weekEvents, specialDayMap) {
  const nav = $('mobileDayTabs');
  nav.replaceChildren();
  const todayStr = today();

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const dayEvs = weekEvents.filter((e) => e.date === date);
    const eff = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const cls = [
      'mobile-day-tab',
      i === selectedDayIndex && 'active',
      date === todayStr && 'is-today',
      eff?.type === 'holiday' && 'is-holiday',
      eff?.type === 'session' && 'is-session',
    ].filter(Boolean).join(' ');

    const btn = node('button', cls);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(i === selectedDayIndex));
    btn.append(
      node('span', 'tab-code', MOBILE_DAY_CODES[i]),
      node('span', 'tab-num', date.slice(8)),
      node('span', dayEvs.length ? 'tab-dot has-events' : 'tab-dot'),
    );
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
      outer.style.setProperty('--marquee-shift', `-${overflowPx + 6}px`);
      outer.style.setProperty('--marquee-time', `${Math.max(5.5, Math.min(14, overflowPx / 12 + 4)).toFixed(1)}s`);
      outer.classList.add('is-overflowing');
    }
  }
}

function updateLiveTimeIndicator() {
  const timeStr = nowTimeLabel();
  if ($('liveClockText')) $('liveClockText').textContent = timeStr;
  if ($('liveClockDate')) {
    const rawDate = shortClockDateFormat.format(new Date()).replace(/\./g, '');
    $('liveClockDate').textContent = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);
  }

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
    const lastEndMin = line.dataset.lastEndMin ? Number(line.dataset.lastEndMin) : null;
    const allFinished = hasEvents && lastEndMin !== null && nowMin >= lastEndMin;
    const outOfGrid = nowMin < startMin || nowMin >= endMin;

    line.hidden = !hasEvents || allFinished || outOfGrid;
    if (!line.hidden) {
      line.style.top = `${((nowMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX}px`;
      if (badge) badge.textContent = `Teraz · ${timeStr}`;
    }

    const daySection = line.closest('.day.today');
    const donePill = daySection?.querySelector('[data-today-done]');
    if (donePill) {
      donePill.hidden = !allFinished;
      daySection.classList.toggle('has-today-done', allFinished);
      $('calendar')?.classList.toggle('has-today-done-stack', allFinished && Boolean(daySection.querySelector('.special-day-badge')));
    }
  }

  for (const evEl of document.querySelectorAll('.day.today .event[data-start-min]')) {
    evEl.classList.toggle('is-now', nowMin >= Number(evEl.dataset.startMin) && nowMin < Number(evEl.dataset.endMin));
  }
}

function render() {
  lastRenderedToday = today();
  const weekEnd = addDays(week, 6);
  $('weekTitle').textContent = `${formatDate(week)} – ${formatDate(weekEnd)} ${week.slice(0, 4)}`;
  $('jump').value = addDays(week, selectedDayIndex);

  const events = state.plan.events.filter((e) => e.date >= week && e.date <= weekEnd);
  const minutes = events.reduce((sum, e) => sum + toMinutes(e.end) - toMinutes(e.start), 0);
  const specialDayMap = new Map((state.plan.academicYear?.specialDays || []).map((sd) => [sd.date, sd]));

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
    for (const g of computeGaps(events.filter((e) => e.date === d))) {
      totalGapCount++;
      totalGapMinutes += g.durationMin;
    }
  }

  const gapSummary = totalGapCount > 0 ? ` · Okienka: ${totalGapCount} (${formatDuration(totalGapMinutes)})` : '';
  $('summary').textContent = `Liczba spotkań: ${events.length} · Łącznie zajęć: ${formatDuration(minutes)}${gapSummary}`;

  renderMobileDayTabs(events, specialDayMap);

  const { startMin, endMin } = getGridBounds(events, weekSpecialDays);
  currentGridBounds = { startMin, endMin };
  const gridTemplate = buildTimelineGridTemplate(startMin, endMin);

  const calendar = $('calendar');
  calendar.classList.toggle('has-special-days', weekHasSpecialDay);
  calendar.replaceChildren(renderTimeColumn(startMin, endMin));

  const slideClass = mobileSlideDir;
  mobileSlideDir = '';

  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const eff = specialDayMap.get(date) || holidayFor(date, state.plan.academicYear);
    const dayEl = renderDay(date, DAY_NAMES[i], events, eff, startMin, endMin, gridTemplate);
    if (i === selectedDayIndex) {
      dayEl.classList.add('mobile-active');
      if (slideClass) dayEl.classList.add(slideClass);
    }
    calendar.append(dayEl);
  }

  updateLiveTimeIndicator();
  requestAnimationFrame(refreshSpecialDayMarquees);
}

function formatSpecialBadge(sd) {
  if (sd.type === 'holiday') return { icon: 'ph-sun-horizon', text: sd.label || 'Dzień wolny' };
  if (sd.type === 'session') return { icon: 'ph-scroll', text: sd.label || 'Sesja egzaminacyjna' };
  const suffix = sd.label ? ` · ${sd.label}` : '';
  if (sd.type === 'swap') {
    return { icon: 'ph-arrows-clockwise', text: `Plan z ${DAY_KEY_NAMES[sd.targetDay] || sd.targetDay}${suffix}` };
  }
  const hours = sd.start && sd.end ? `Rektorskie ${sd.start}–${sd.end}` : 'Dzień rektorski';
  return { icon: 'ph-graduation-cap', text: `${hours}${suffix}` };
}

function renderDay(date, dayName, weekEvents, specialDay, gridStartMin, gridEndMin, gridTemplate) {
  const isHoliday = specialDay?.type === 'holiday';
  const isRector = specialDay?.type === 'rector';
  const isSession = specialDay?.type === 'session';
  const isToday = date === today();

  const day = node('section', ['day', isToday && 'today', isHoliday && 'holiday', isSession && 'session', isRector && 'rector-day'].filter(Boolean).join(' '));
  const topWrap = node('div', 'day-top');
  const head = node('div', editMode ? 'dayhead editable' : 'dayhead');
  const headInfo = node('div', 'dayhead-info');
  headInfo.append(node('span', '', dayName), node('strong', '', date.slice(8)));
  head.append(headInfo);

  if (editMode) {
    head.title = isHoliday
      ? `Dzień wolny (${date}) — kliknij, aby dodać wydarzenie własne (poza przedmiotem)`
      : isSession
        ? `Sesja egzaminacyjna (${date}) — kliknij, aby dodać egzamin, poprawkę lub zaliczenie`
        : `Kliknij, aby dodać zajęcia w dniu ${date} (${dayName})`;
    head.onclick = () => openEventDialog(null, date);
    const addHint = node('span', 'dayhead-add');
    addHint.innerHTML = '<i class="ph ph-plus"></i>';
    addHint.title = isHoliday ? 'Dodaj wydarzenie własne' : isSession ? 'Dodaj egzamin / zaliczenie' : 'Dodaj zajęcia w tym dniu';
    head.append(addHint);
  }
  topWrap.append(head);

  if (isToday) {
    const donePill = node('div', 'today-done-pill');
    donePill.setAttribute('data-today-done', '');
    donePill.hidden = true;
    donePill.title = 'Wszystkie zaplanowane na dziś zajęcia i wydarzenia już się zakończyły';
    donePill.innerHTML = '<i class="ph-fill ph-check-circle"></i><span>Koniec na dziś</span>';
    topWrap.append(donePill);
  }

  if (specialDay) {
    const { icon, text } = formatSpecialBadge(specialDay);
    const badge = node('div', `special-day-badge ${specialDay.type}${editMode ? ' editable' : ''}`);
    const labelOuter = node('span', 'special-day-label');
    labelOuter.append(node('span', 'special-day-label-inner', text));
    badge.append(node('i', `ph ${icon}`), labelOuter);
    badge.title = editMode ? `${text} — kliknij, aby zarządzać strukturą roku` : text;
    if (editMode) badge.onclick = openAcademicYearDialog;
    topWrap.append(badge);
  }

  day.append(topWrap);

  const dayEvents = weekEvents.filter((e) => e.date === date).sort((a, b) => a.start.localeCompare(b.start));
  const rectorImpact = isRector ? describeRectorImpact(dayEvents, specialDay) : null;
  const totalSlots = (gridEndMin - gridStartMin) / SLOT_MINUTES;

  const timeline = node('div', `day-timeline${editMode ? ' editable' : ''}${rectorImpact?.fullDayFree ? ' rector-full-free' : ''}`);
  timeline.style.height = `${totalSlots * SLOT_HEIGHT_PX}px`;
  if (gridTemplate) timeline.append(gridTemplate.cloneNode(true));

  if (editMode) {
    timeline.title = isHoliday
      ? 'Kliknij w wiersz godziny, aby dodać wydarzenie własne o tej porze'
      : isSession
        ? 'Kliknij w wiersz godziny, aby dodać egzamin lub zaliczenie o tej porze'
        : 'Kliknij w wiersz godziny, aby dodać zajęcia o tej porze';
    timeline.onclick = (e) => {
      if (e.target !== timeline) return;
      const slotIndex = Math.max(0, Math.min(totalSlots - 2, Math.floor(e.offsetY / SLOT_HEIGHT_PX)));
      openEventDialog(null, date, fromMinutes(gridStartMin + slotIndex * SLOT_MINUTES));
    };
  }

  const GAP_INSET_PX = 3;
  for (const gap of computeGaps(dayEvents)) {
    const cancelled =
      isRector &&
      (rectorImpact?.fullDayFree ||
        (specialDay.start && specialDay.end && gap.startMin < toMinutes(specialDay.end) && gap.endMin > toMinutes(specialDay.start)));
    const gapEl = node('div', `gap-block${cancelled ? ' cancelled-by-rector' : ''}`);
    gapEl.style.top = `${((gap.startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + GAP_INSET_PX}px`;
    gapEl.style.height = `${Math.max(SLOT_HEIGHT_PX - GAP_INSET_PX * 2, (gap.durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - GAP_INSET_PX * 2)}px`;
    const title = node('span', 'gap-title');
    title.innerHTML = '<i class="ph ph-hourglass-low"></i> ';
    title.append(document.createTextNode(`Okienko · ${formatDuration(gap.durationMin)}`));
    gapEl.append(title);
    if (gap.durationMin >= 10) gapEl.append(node('span', 'gap-time', `${fromMinutes(gap.startMin)} – ${fromMinutes(gap.endMin)}`));
    timeline.append(gapEl);
  }

  const layoutMap = layoutDayEvents(dayEvents);
  for (const event of dayEvents) timeline.append(renderEvent(event, layoutMap.get(event.id), gridStartMin, specialDay));

  if (isToday) {
    const activeDayEvents = dayEvents.filter((e) => !isEventCancelledByRector(e, specialDay));
    const lastEndMin = activeDayEvents.length ? Math.max(...activeDayEvents.map((e) => toMinutes(e.end))) : null;
    const nowLine = node('div', 'now-line');
    nowLine.setAttribute('data-now-line', '');
    nowLine.dataset.hasEvents = String(activeDayEvents.length > 0);
    nowLine.dataset.lastEndMin = lastEndMin !== null ? String(lastEndMin) : '';
    nowLine.setAttribute('aria-hidden', 'true');
    const nowBadge = node('span', 'now-badge');
    nowBadge.setAttribute('data-now-badge', '');
    nowLine.append(node('span', 'now-dot'), nowBadge);
    timeline.append(nowLine);
  }

  if (isRector && rectorImpact) {
    const overlay = node('div', rectorImpact.fullDayFree ? 'rector-overlay full-day' : 'rector-overlay partial-day');
    if (!rectorImpact.fullDayFree && specialDay.start && specialDay.end) {
      const rStart = Math.max(gridStartMin, toMinutes(specialDay.start));
      const rEnd = Math.min(gridEndMin, toMinutes(specialDay.end));
      overlay.style.top = `${((rStart - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX}px`;
      overlay.style.height = `${Math.max(SLOT_HEIGHT_PX * 2, ((rEnd - rStart) / SLOT_MINUTES) * SLOT_HEIGHT_PX)}px`;
    }
    const card = node('div', 'rector-overlay-card');
    const titleEl = node('div', 'rector-overlay-title');
    titleEl.innerHTML = '<i class="ph ph-graduation-cap"></i> ';
    titleEl.append(document.createTextNode(rectorImpact.title));
    card.append(
      titleEl,
      node('div', 'rector-overlay-meta', specialDay.label ? `${rectorImpact.hoursLabel} · ${specialDay.label}` : rectorImpact.hoursLabel),
      node('div', 'rector-overlay-free', rectorImpact.freeSummary),
    );
    overlay.append(card);
    timeline.append(overlay);
  }

  if (!dayEvents.length && !isRector) {
    if (editMode) {
      const emptyBtn = node('button', 'day-empty-btn');
      emptyBtn.type = 'button';
      emptyBtn.innerHTML = `<i class="ph ph-plus-circle"></i> ${isHoliday ? 'Dodaj wydarzenie własne' : isSession ? 'Dodaj egzamin / zaliczenie' : 'Dodaj zajęcia'}`;
      emptyBtn.onclick = () => openEventDialog(null, date);
      timeline.append(emptyBtn);
    } else {
      const overlayEl = node('div', `day-empty-overlay${isSession ? ' session-empty' : ''}`);
      if (isHoliday) overlayEl.innerHTML = '<i class="ph ph-sun-horizon"></i> Dzień wolny od zajęć';
      else if (isSession) overlayEl.innerHTML = '<i class="ph ph-scroll"></i> Sesja egzaminacyjna';
      else overlayEl.textContent = 'Brak zajęć';
      timeline.append(overlayEl);
    }
  }

  day.append(timeline);
  return day;
}

function getEventDisplay(event) {
  if (event.subjectId) {
    const subject = state.plan.subjects.find((s) => s.id === event.subjectId) || null;
    return { title: subject?.name || 'Przedmiot', isCustom: false, subject };
  }
  return { title: event.customTitle || 'Wydarzenie', isCustom: true, subject: null };
}

function getEventTypeVisual(typeStr, isCustom = false) {
  const t = (typeStr || '').toLowerCase();
  const match = TYPE_VISUAL_RULES.find(([keys]) => keys.some((k) => t.includes(k)));
  return match
    ? { variant: match[1], icon: match[2] }
    : { variant: 'type-other', icon: isCustom ? 'ph-calendar-star' : 'ph-tag' };
}

function renderEvent(event, layout, gridStartMin, specialDay = null) {
  const { title, isCustom } = getEventDisplay(event);
  const typeVisual = getEventTypeVisual(event.type, isCustom);
  const startMin = toMinutes(event.start);
  const endMin = toMinutes(event.end);
  const durationMin = Math.max(SLOT_MINUTES, endMin - startMin);
  const cancelledByRector = isEventCancelledByRector(event, specialDay);

  const INSET = 1;
  const sizeClass = durationMin < 20 ? 'compact' : durationMin <= 40 ? 'short-block' : durationMin <= 55 ? 'medium-block' : 'tall-block';
  const className = [
    'event',
    typeVisual.variant,
    event.remote && 'remote',
    isCustom && 'custom-event',
    cancelledByRector && 'cancelled-by-rector',
    sizeClass,
  ].filter(Boolean).join(' ');

  const button = node('button', className);
  button.type = 'button';
  button.dataset.startMin = String(startMin);
  button.dataset.endMin = String(endMin);
  button.title = [`${event.start} – ${event.end}`, title, event.type, event.room, event.teacher].filter(Boolean).join(' · ');
  button.style.top = `${((startMin - gridStartMin) / SLOT_MINUTES) * SLOT_HEIGHT_PX + INSET}px`;
  button.style.height = `${Math.max(SLOT_HEIGHT_PX - INSET * 2, (durationMin / SLOT_MINUTES) * SLOT_HEIGHT_PX - INSET * 2)}px`;

  const { col = 0, totalCols = 1, overlaps = false } = layout || {};
  const widthPct = 100 / totalCols;
  button.style.left = `calc(${col * widthPct}% + 3px)`;
  button.style.width = `calc(${widthPct}% - 6px)`;

  const topRow = node('div', 'event-top-row');
  topRow.append(node('span', 'time', `${event.start} – ${event.end}`));
  if (cancelledByRector) topRow.append(iconTag('rector-tag', 'ph-graduation-cap', 'Odwołane'));
  if (isCustom) topRow.append(iconTag('custom-tag', 'ph-star-four', 'Własne'));
  if (event.remote) topRow.append(iconTag('remote-tag', 'ph-laptop', 'Zdalnie'));

  button.append(topRow, node('span', 'name', title));
  if (event.room || event.teacher) button.append(node('span', 'meta', [event.room, event.teacher].filter(Boolean).join(' · ')));
  button.append(iconTag(`type-tag ${typeVisual.variant}`, typeVisual.icon, event.type));
  if (overlaps) button.append(node('span', 'meta', '⚠ Nakładające się godziny'));
  if (event.notes) button.append(node('span', 'meta', event.notes));

  button.onclick = (e) => {
    e.stopPropagation();
    if (editMode) openEventDialog(event.id);
    else openEventDetailsDialog(event.id);
  };
  return button;
}

// --- Szczegóły zajęć ---------------------------------------------------------

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

  $('detailsNotesSection').hidden = !event.notes?.trim();
  renderRichTextWithLinks($('detailsNotes'), event.notes || '');
  $('copyEventNotesBtn').onclick = () => copyTextWithFeedback(event.notes || '', $('copyEventNotesBtn'), 'Kopiuj notatkę');

  if (isCustom || !subject) {
    $('detailsSubjectSection').hidden = true;
    $('detailsEditSubjectBtn').hidden = true;
  } else {
    $('detailsEditSubjectBtn').hidden = false;
    $('detailsSubjectSection').hidden = false;
    const text = (subject.details || '').trim();
    if (text) renderRichTextWithLinks($('detailsSubjectInfo'), text);
    else $('detailsSubjectInfo').textContent = 'Brak opisu przedmiotu. Możesz go dodać przyciskiem „Edytuj opis przedmiotu”.';
    $('copySubjectDetailsBtn').hidden = !text;
    $('copySubjectDetailsBtn').onclick = () => copyTextWithFeedback(subject.details || '', $('copySubjectDetailsBtn'), 'Kopiuj opis');
  }

  showDialogModal($('eventDetailsDialog'));
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
    nameRow.append(node('i', 'ph ph-book-bookmark'), node('span', '', subject.name));
    info.append(nameRow);
    if (subject.details) info.append(node('div', 'subjectrow-details', subject.details));

    const editBtn = node('button', '', 'Edytuj');
    editBtn.type = 'button';
    editBtn.onclick = () => fillSubjectForm(subject);
    const delBtn = node('button', 'danger', 'Usuń');
    delBtn.type = 'button';
    delBtn.onclick = () => deleteSubject(subject);

    row.append(info, editBtn, delBtn);
    list.append(row);
  }
}

function resetSubjectForm() {
  $('subjectForm').reset();
  $('subjectId').value = '';
  $('subjectDetails').value = '';
}

function openSubjectDialog(message = '', subjectToEdit = null) {
  renderSubjectList();
  resetSubjectForm();
  if (subjectToEdit) fillSubjectForm(subjectToEdit);
  $('subjectError').textContent = message;
  showDialogModal($('subjectDialog'));
}

function deleteSubject(subject) {
  try {
    const count = state.plan.events.filter((e) => e.subjectId === subject.id).length;
    const msg = count > 0
      ? `Przedmiot „${subject.name}” ma przypisane zajęcia (${count} spotkań). Czy usunąć ten przedmiot razem ze wszystkimi jego zajęciami?`
      : `Usunąć przedmiot „${subject.name}”?`;
    if (!confirm(msg)) return;
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
      const dup = plan.subjects.find((s) => s.id !== id && s.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl'));
      if (dup) throw Error('Taki przedmiot już istnieje. Dodaj do niego inny typ zajęć.');
      const subject = details ? { id, name, details } : { id, name };
      const idx = plan.subjects.findIndex((s) => s.id === id);
      if (idx < 0) plan.subjects.push(subject);
      else plan.subjects[idx] = subject;
    });
    resetSubjectForm();
    $('subjectError').textContent = '';
    renderSubjectList();
  } catch (err) {
    $('subjectError').textContent = err.message;
  }
}

// --- Zajęcia (formularz i serie) ---------------------------------------------

function toggleCustomInput(selectEl, inputEl, customValue, focus = false) {
  const isCustom = selectEl.value === customValue;
  inputEl.hidden = !isCustom;
  inputEl.required = isCustom;
  if (isCustom && focus) inputEl.focus();
}

function syncCustomSelect(selectEl, inputEl, value, customValue, fallback = '') {
  const val = (value ?? fallback).trim();
  const match = Array.from(selectEl.options).find(
    (opt) => opt.value !== customValue && opt.value.toLowerCase() === val.toLowerCase(),
  );
  if (match) {
    selectEl.value = match.value;
    inputEl.value = '';
    inputEl.hidden = true;
    inputEl.required = false;
  } else {
    selectEl.value = customValue;
    inputEl.value = val;
    inputEl.hidden = false;
    inputEl.required = true;
  }
}

function setSelectedEventType(typeValue, isCustomEvent = false) {
  const fallback = isCustomEvent ? 'Spotkanie' : 'Laboratorium';
  syncCustomSelect($('typeSelect'), $('typeCustom'), typeValue || fallback, CUSTOM_TYPE_VALUE, fallback);
}

function getSelectedEventType(isCustomEvent = false) {
  if ($('typeSelect').value === CUSTOM_TYPE_VALUE) {
    return $('typeCustom').value.trim() || (isCustomEvent ? 'Wydarzenie własne' : 'Laboratorium');
  }
  return $('typeSelect').value;
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
    if (isCustom && $('typeSelect').value === 'Laboratorium') setSelectedEventType('Spotkanie', true);
    else if (!isCustom && $('typeSelect').value === 'Spotkanie') setSelectedEventType('Laboratorium', false);
    if (isCustom && $('start').value === '08:00' && $('end').value === '09:30') $('end').value = '09:00';
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
    const opt = node('option', '', subject.name);
    opt.value = subject.id;
    select.append(opt);
  }
  const customOption = node('option', '', '★ Wydarzenie własne / poza przedmiotem (np. promotor, dentysta)');
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
  const fallbackDate = findDefaultNonHolidayDate(t >= week && t <= addDays(week, 6) ? t : week);
  const targetDate = event?.date || initialDate || fallbackDate;
  $('date').value = targetDate;

  if (event) {
    for (const field of EVENT_FIELDS) $(field).value = event[field];
    setSelectedEventType(event.type, !event.subjectId);
    $('remote').checked = !!event.remote;
    select.value = event.subjectId || CUSTOM_SUBJECT_VALUE;
    $('customTitle').value = event.subjectId ? '' : event.customTitle || '';
    $('scope').value = 'one';
  } else {
    $('remote').checked = false;
    $('customTitle').value = '';
    const isTargetHoliday = !!holidayFor(targetDate, state.plan.academicYear);
    const isTargetSession = (state.plan.academicYear?.specialDays || []).some((sd) => sd.date === targetDate && sd.type === 'session');
    const defaultToCustom = !state.plan.subjects.length || isTargetHoliday;
    if (defaultToCustom) select.value = CUSTOM_SUBJECT_VALUE;
    setSelectedEventType(defaultToCustom ? 'Spotkanie' : isTargetSession ? 'Egzamin' : 'Laboratorium', defaultToCustom);
    const startVal = initialStart || (defaultToCustom ? '12:00' : '08:00');
    $('start').value = startVal;
    $('end').value = fromMinutes(Math.min(23 * 60 + 55, toMinutes(startVal) + (defaultToCustom ? 60 : 90)));
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
  const end = $('end').value.trim() || fromMinutes(Math.min(23 * 60 + 55, toMinutes(start) + (isCustom ? 60 : 90)));
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
  if (isCustom) base.customTitle = $('customTitle').value.trim();
  return base;
}

function inScope(e, original, scope) {
  if (e.id === original.id) return true;
  if (scope === 'all') return e.seriesId === original.seriesId;
  return scope === 'future' && e.seriesId === original.seriesId && e.date >= original.date;
}

function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  try {
    const values = readEventForm();
    if (values.end <= values.start) throw Error('Godzina zakończenia musi być późniejsza niż rozpoczęcia.');
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
            throw Error(`${values.date} to dzień wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`);
          }
        }
        plan.events = plan.events.map((e) => {
          if (!inScope(e, original, scope)) return e;
          const nextDate = addDays(e.date, shiftDays);
          if (!isCustom && shiftDays !== 0 && holidayFor(nextDate, plan.academicYear)) return null;
          const updated = { ...e, ...values, date: nextDate };
          if (values.subjectId) { delete updated.customTitle; delete updated.customColor; }
          return updated;
        }).filter(Boolean);
      } else {
        if (!isCustom && applyAcademicYear) {
          const startHoliday = holidayFor(values.date, plan.academicYear);
          if (startHoliday) {
            const reason = startHoliday.label ? ` (${startHoliday.label})` : '';
            throw Error(`Wybrany dzień (${values.date}) jest ustawiony jako wolny${reason}. W weekendy i dni wolne można dodawać wyłącznie wydarzenia własne (poza przedmiotem).`);
          }
        }
        const seriesId = uid();
        const dates = datesFor(values.date, $('until').value, $('repeat').value, $('manual').value, plan.academicYear, applyAcademicYear, isCustom);
        for (const date of dates) plan.events.push({ ...values, date, id: uid(), seriesId });
      }
    });
    $('eventDialog').close();
  } catch (err) {
    $('eventError').textContent = err.message;
  }
}

function deleteEvent() {
  const scope = $('scope').value;
  const confirmMsgs = {
    one: 'Czy na pewno usunąć tylko to jedno spotkanie z planu?',
    future: 'Czy na pewno usunąć to i wszystkie kolejne spotkania tej serii?',
    all: 'Czy na pewno usunąć CAŁĄ serię zajęć (ze wszystkich tygodni oraz przeniesionych dni)?',
  };
  if (!confirm(confirmMsgs[scope] || confirmMsgs.one)) return;
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

// --- Masowe usuwanie i czyszczenie planu -------------------------------------

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

  for (const [seriesId, events] of groups) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    const first = events[0];
    const last = events[events.length - 1];
    const { title: subjectName } = getEventDisplay(first);

    const row = node('div', 'seriesrow');
    const info = node('div', 'seriesrow-info');
    info.append(
      node('div', 'seriesrow-title', `${subjectName} · ${first.type} (${first.start}–${first.end})`),
      node('div', 'seriesrow-meta', events.length > 1 ? `Spotkań: ${events.length} · Zakres: ${first.date} → ${last.date}` : `Pojedyncze spotkanie: ${first.date}`),
    );
    const delBtn = node('button', 'danger', events.length > 1 ? `Usuń serię (${events.length})` : 'Usuń');
    delBtn.type = 'button';
    delBtn.onclick = () => {
      if (!confirm(`Usunąć wszystkie spotkania z serii „${subjectName} (${first.type})” (${events.length} terminów, w tym przeniesione dni)?`)) return;
      mutate((plan) => { plan.events = plan.events.filter((e) => e.seriesId !== seriesId); });
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
    setStatus(`Przeliczono serie wg struktury roku: usunięto ${summary.removed} z dni wolnych/zamienionych, dodano ${summary.added} w dniach z zamianą planu.`);
  } catch (err) {
    setStatus(err.message);
  }
}

function clearAllEvents() {
  if (!state.plan.events.length) {
    setStatus('Brak zajęć do usunięcia.');
    return;
  }
  if (!confirm(`Czy na pewno usunąć WSZYSTKIE zajęcia (${state.plan.events.length} spotkań) z planu zajęć? Przedmioty oraz struktura roku zostaną zachowane.`)) return;
  mutate((plan) => { plan.events = []; });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Usunięto wszystkie zajęcia. Kliknij „Zapisz w chmurze”, jeśli chcesz nadpisać również plan w chmurze.');
}

function clearEntireCalendar() {
  if (!confirm('Czy na pewno wyczyścić CAŁY plan zajęć do zera (wszystkie zajęcia, przedmioty oraz strukturę roku)? Tej operacji nie można cofnąć lokalnie bez kopii JSON.')) return;
  mutate((plan) => { Object.assign(plan, emptyPlan()); });
  renderSeriesList();
  $('bulkDialog').close();
  setStatus('Plan zajęć został całkowicie wyczyszczony do zera. Kliknij „Zapisz w chmurze”, aby nadpisać dane w chmurze.');
}

// --- Struktura roku akademickiego --------------------------------------------

function groupSpecialDays(specialDays) {
  const sorted = [...specialDays].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.type === 'holiday' || cur.type === 'session') {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].type === cur.type && (sorted[j + 1].label || '') === (cur.label || '') && sorted[j + 1].date === addDays(sorted[j].date, 1)) j++;
      if (j > i) {
        groups.push({ type: cur.type, label: cur.label, startDate: cur.date, endDate: sorted[j].date, count: j - i + 1, dates: sorted.slice(i, j + 1).map((x) => x.date) });
        i = j;
        continue;
      }
    }
    groups.push({ ...cur, startDate: cur.date, endDate: cur.date, count: 1, dates: [cur.date] });
  }
  return groups;
}

function renderSpecialDaysList() {
  const container = $('specialDayList');
  container.replaceChildren();
  const specialDays = state.plan.academicYear?.specialDays || [];
  if (!specialDays.length) {
    container.append(node('p', 'hint', 'Brak zdefiniowanych dni wolnych, sesji, przerw i godzin rektorskich. Dodaj je poniżej.'));
    return;
  }

  for (const g of groupSpecialDays(specialDays)) {
    const isRange = g.count > 1;
    const badgeText =
      g.type === 'holiday' ? (isRange ? `Przerwa (${g.count} dni)` : 'Wolne')
        : g.type === 'session' ? (isRange ? `Sesja (${g.count} dni)` : 'Sesja')
          : g.type === 'rector' ? (g.start && g.end ? `Rektorskie ${g.start}–${g.end}` : 'Dzień rektorski')
            : 'Zamiana';

    let descText = g.label || (g.type === 'holiday' ? (isRange ? 'Przerwa świąteczna / wolna' : 'Dzień wolny')
      : g.type === 'session' ? (isRange ? 'Sesja egzaminacyjna / poprawkowa (brak zwykłych zajęć)' : 'Dzień sesji egzaminacyjnej') : '');
    if (g.type === 'swap') {
      const swapDesc = `Zajęcia według planu z ${DAY_KEY_NAMES[g.targetDay] || g.targetDay}`;
      descText = descText ? `${swapDesc} (${descText})` : swapDesc;
    } else if (g.type === 'rector') {
      const rectorDesc = g.start && g.end ? `Godziny rektorskie ${g.start} – ${g.end} (nakładka na plan)` : 'Dzień rektorski — cały dzień (nakładka na plan)';
      descText = g.label ? `${rectorDesc} · ${g.label}` : rectorDesc;
    }

    const row = node('div', 'specialdayrow');
    const info = node('div', 'specialdayrow-info');
    const dateLine = node('div', 'specialdayrow-date');
    dateLine.append(node('span', '', isRange ? `${g.startDate} → ${g.endDate}` : g.startDate), node('span', `badge ${g.type}`, badgeText));
    info.append(dateLine, node('div', 'specialdayrow-desc', descText));

    const delBtn = node('button', 'danger', 'Usuń');
    delBtn.type = 'button';
    delBtn.onclick = () => deleteSpecialDays(g.dates);
    row.append(info, delBtn);
    container.append(row);
  }
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
  $('specialDayDateLabel').childNodes[0].textContent = isRange ? 'Data od: ' : 'Data: ';
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

    if (type === 'rector' && !rectorFullDay && (!rectorStart || !rectorEnd || rectorEnd <= rectorStart)) {
      throw Error('Godzina zakończenia godzin rektorskich musi być późniejsza niż godzina rozpoczęcia.');
    }

    const datesToAdd = [];
    if (type === 'holiday_range' || type === 'session_range') {
      if (!endDate || endDate < startDate) throw Error('Data końcowa musi być późniejsza lub równa dacie początkowej.');
      for (let cur = startDate; cur <= endDate; cur = addDays(cur, 1)) {
        if (datesToAdd.length >= 366) throw Error('Zakres nie może trwać dłużej niż 366 dni.');
        datesToAdd.push(cur);
      }
    } else {
      datesToAdd.push(startDate);
    }

    mutate((plan) => {
      if (!plan.academicYear) plan.academicYear = { specialDays: [] };
      const existing = new Set(plan.academicYear.specialDays.map((sd) => sd.date));
      for (const d of datesToAdd) {
        if (existing.has(d)) throw Error(`Dla dnia ${d} już istnieje wpis w strukturze roku. Najpierw go usuń.`);
      }

      const normalizedType = type === 'session' || type === 'session_range' ? 'session' : type === 'swap' ? 'swap' : 'holiday';
      for (const d of datesToAdd) {
        if (type === 'rector') {
          const item = { date: d, type: 'rector', label };
          if (!rectorFullDay) { item.start = rectorStart; item.end = rectorEnd; }
          plan.academicYear.specialDays.push(item);
        } else {
          const item = { date: d, type: normalizedType, label };
          if (type === 'swap') item.targetDay = targetDay;
          plan.academicYear.specialDays.push(item);
        }
      }
      plan.events = reconcileWithAcademicYear(plan, uid).events;
    });

    $('specialDayLabel').value = '';
    $('academicYearError').textContent = '';
    renderSpecialDaysList();
  } catch (err) {
    $('academicYearError').textContent = err.message;
  }
}

// --- Tablica Kanban ----------------------------------------------------------

function getKnownSubjectNames() {
  const names = new Set();
  for (const s of state.plan.subjects) if (s.name?.trim()) names.add(s.name.trim());
  for (const c of kanbanState.kanban.cards) if (c.subjectName?.trim()) names.add(c.subjectName.trim());
  return [...names].sort((a, b) => a.localeCompare(b, 'pl'));
}

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
  const diffDays = Math.round((Date.parse(dueDate + 'T12:00:00Z') - Date.parse(today() + 'T12:00:00Z')) / 86_400_000);
  if (isDoneCol) return { label: formatDate(dueDate), variant: 'done', icon: 'ph-calendar-check' };
  if (diffDays < 0) return { label: `Po terminie (${formatDate(dueDate)})`, variant: 'overdue', icon: 'ph-warning-circle' };
  if (diffDays === 0) return { label: 'Dzisiaj!', variant: 'due-soon', icon: 'ph-alarm' };
  if (diffDays === 1) return { label: 'Jutro', variant: 'due-soon', icon: 'ph-clock-countdown' };
  if (diffDays <= 3) return { label: `Za ${diffDays} dni (${formatDate(dueDate)})`, variant: 'due-soon', icon: 'ph-clock' };
  return { label: formatDate(dueDate), variant: 'normal', icon: 'ph-calendar-blank' };
}

function updateKanbanSubjectFilterOptions() {
  const select = $('kanbanFilterSubject');
  const prevValue = select.value;
  select.replaceChildren();
  const options = [['', 'Wszystkie przedmioty'], ['__none__', 'Ogólne (bez przedmiotu)'], ...getKnownSubjectNames().map((n) => [n, n])];
  for (const [val, label] of options) {
    const opt = node('option', '', label);
    opt.value = val;
    select.append(opt);
  }
  if (Array.from(select.options).some((o) => o.value === prevValue)) select.value = prevValue;
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
      const hay = [card.title, card.description || '', card.subjectName || '', card.category || '', ...(card.checklist || []).map((i) => i.text)]
        .join(' ').toLocaleLowerCase('pl');
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function renderMobileKanbanTabs(filteredCards) {
  const nav = $('mobileKanbanTabs');
  nav.replaceChildren();
  const cols = kanbanState.kanban.columns;
  if (selectedKanbanColIndex >= cols.length) selectedKanbanColIndex = Math.max(0, cols.length - 1);

  cols.forEach((col, idx) => {
    const count = filteredCards.filter((c) => c.columnId === col.id).length;
    const btn = node('button', `mobile-day-tab${idx === selectedKanbanColIndex ? ' active' : ''}`);
    btn.type = 'button';
    btn.append(node('span', 'tab-code', col.title), node('span', 'tab-num', `${count}`));
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
    const colCards = kanban.cards.filter((c) => c.columnId === targetColumnId && c.id !== cardId).sort((a, b) => a.order - b.order);
    const insertAt = targetIndex === null ? colCards.length : Math.max(0, Math.min(colCards.length, targetIndex));
    colCards.splice(insertAt, 0, card);
    colCards.forEach((c, idx) => { c.order = idx; });
  });
}

function toggleKanbanChecklistItem(cardId, itemId) {
  mutateKanban((kanban) => {
    const item = kanban.cards.find((c) => c.id === cardId)?.checklist?.find((i) => i.id === itemId);
    if (item) item.done = !item.done;
  });
}

function buildChecklistItems(checklist, onToggle) {
  const frag = document.createDocumentFragment();
  for (const item of checklist) {
    const row = node('label', `kanban-card-checkitem${item.done ? ' done' : ''}`);
    row.onclick = (e) => e.stopPropagation();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.onchange = (e) => {
      e.stopPropagation();
      onToggle(item);
    };
    row.append(cb, node('span', '', item.text));
    frag.append(row);
  }
  return frag;
}

function openKanbanDetailsDialog(cardId) {
  const card = kanbanState.kanban.cards.find((c) => c.id === cardId);
  if (!card) return;
  detailsKanbanCardId = card.id;

  const cols = kanbanState.kanban.columns;
  const col = cols.find((c) => c.id === card.columnId);
  const isDoneCol = cols.length > 1 && cols[cols.length - 1]?.id === card.columnId;

  $('kanbanDetailsTitle').textContent = card.title;
  $('kanbanDetailsColumn').textContent = col ? col.title : 'Zadanie';
  $('kanbanDetailsPriority').textContent = `Priorytet: ${PRIORITY_LABELS[card.priority] || 'Średni'}`;

  const setBadge = (el, show, icon, text) => {
    el.hidden = !show;
    if (show) {
      el.innerHTML = `<i class="ph ${icon}"></i> `;
      el.append(document.createTextNode(text));
    }
  };
  setBadge($('kanbanDetailsCategory'), !!card.category, getEventTypeVisual(card.category, false).icon, card.category || '');
  setBadge($('kanbanDetailsSubject'), !!card.subjectName, 'ph-book-bookmark', card.subjectName || '');
  const dueInfo = getDueDateStatus(card.dueDate, isDoneCol);
  setBadge($('kanbanDetailsDue'), !!dueInfo, dueInfo?.icon || '', dueInfo ? `Termin: ${dueInfo.label}` : '');

  $('kanbanDetailsDescSection').hidden = !card.description?.trim();
  renderRichTextWithLinks($('kanbanDetailsDesc'), card.description || '');
  $('copyKanbanDescBtn').onclick = () => copyTextWithFeedback(card.description || '', $('copyKanbanDescBtn'), 'Kopiuj notatkę');

  const hasCheck = Boolean(card.checklist?.length);
  $('kanbanDetailsChecklistSection').hidden = !hasCheck;
  const checkContainer = $('kanbanDetailsChecklist');
  checkContainer.replaceChildren();
  if (hasCheck) {
    const doneCount = card.checklist.filter((i) => i.done).length;
    $('kanbanDetailsChecklistHead').textContent = `Lista podzadań (${doneCount}/${card.checklist.length})`;
    checkContainer.append(buildChecklistItems(card.checklist, (item) => {
      toggleKanbanChecklistItem(card.id, item.id);
      openKanbanDetailsDialog(card.id);
    }));
  }

  $('kanbanDetailsEditBtn').hidden = !editMode;
  showDialogModal($('kanbanDetailsDialog'));
}

function renderKanbanCard(card, colIndex, totalCols, isDoneCol) {
  const el = node('article', `kanban-card priority-${card.priority}${isDoneCol ? ' is-done' : ''}${editMode ? ' editable' : ''}`);
  el.draggable = true;
  el.dataset.cardId = card.id;

  const allowSelectAndCheck = (targetEl) => {
    targetEl.addEventListener('mouseenter', () => { el.draggable = false; });
    targetEl.addEventListener('mouseleave', () => { el.draggable = true; });
    targetEl.addEventListener('touchstart', () => { el.draggable = false; }, { passive: true });
  };

  el.addEventListener('dragstart', (e) => {
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
    for (const colEl of document.querySelectorAll('.kanban-col.drag-over')) colEl.classList.remove('drag-over');
  });
  el.onclick = (e) => {
    if (window.getSelection?.()?.toString().trim() || e.target?.closest?.('a, button, input, label')) return;
    if (editMode) openKanbanCardDialog(card.id);
    else openKanbanDetailsDialog(card.id);
  };

  const badgesRow = node('div', 'kanban-card-badges');
  const dragHandle = node('span', 'kanban-drag-handle');
  dragHandle.title = 'Chwyć tutaj, aby przeciągnąć kartę';
  dragHandle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
  badgesRow.append(dragHandle);

  const prioIcon = card.priority === 'high' ? 'ph-fire' : card.priority === 'medium' ? 'ph-flag' : 'ph-arrow-down-right';
  badgesRow.append(iconTag(`kanban-prio-badge priority-${card.priority}`, prioIcon, PRIORITY_LABELS[card.priority] || 'Średni'));

  if (card.category) {
    const tv = getEventTypeVisual(card.category, false);
    badgesRow.append(iconTag(`type-tag ${tv.variant}`, tv.icon, card.category));
  }
  if (card.subjectName) badgesRow.append(iconTag('kanban-subject-badge', 'ph-book-bookmark', card.subjectName));
  const dueInfo = getDueDateStatus(card.dueDate, isDoneCol);
  if (dueInfo) badgesRow.append(iconTag(`kanban-due-badge ${dueInfo.variant}`, dueInfo.icon, dueInfo.label));

  const titleBtn = node('button', 'kanban-card-title-btn', card.title);
  titleBtn.type = 'button';
  titleBtn.onclick = (e) => {
    e.stopPropagation();
    if (editMode) openKanbanCardDialog(card.id);
    else openKanbanDetailsDialog(card.id);
  };
  el.append(badgesRow, titleBtn);

  if (card.description?.trim()) {
    const descWrap = node('div', 'kanban-card-desc-wrap');
    const descEl = node('div', 'kanban-card-desc');
    renderRichTextWithLinks(descEl, card.description);
    allowSelectAndCheck(descWrap);

    const previewActions = node('div', 'kanban-desc-actions');
    const viewBtn = iconBtn('kanban-note-action-btn', 'ph-eye', 'Pełny podgląd notatki', (e) => {
      e.stopPropagation();
      openKanbanDetailsDialog(card.id);
    });
    const copyBtn = iconBtn('kanban-note-action-btn', 'ph-copy', 'Kopiuj notatkę', (e) => {
      e.stopPropagation();
      copyTextWithFeedback(card.description, copyBtn);
    });
    previewActions.append(viewBtn, copyBtn);
    descWrap.append(descEl, previewActions);
    el.append(descWrap);
  }

  if (card.checklist?.length) {
    const doneCount = card.checklist.filter((i) => i.done).length;
    const totalCount = card.checklist.length;
    const pct = Math.round((doneCount / totalCount) * 100);

    const checkWrap = node('div', 'kanban-card-checklist');
    allowSelectAndCheck(checkWrap);
    const progressHead = node('div', 'kanban-check-progress-head');
    const checkLabel = node('span', 'kanban-check-count');
    checkLabel.innerHTML = `<i class="ph ph-check-square-offset"></i> ${doneCount}/${totalCount}`;

    const progressBar = node('div', 'kanban-check-bar');
    const progressFill = node('div', 'kanban-check-fill');
    progressFill.style.width = `${pct}%`;
    progressBar.append(progressFill);
    progressHead.append(checkLabel, progressBar, node('span', 'kanban-check-pct', `${pct}%`));

    const listEl = node('div', 'kanban-card-checkitems');
    listEl.append(buildChecklistItems(card.checklist, (item) => toggleKanbanChecklistItem(card.id, item.id)));
    checkWrap.append(progressHead, listEl);
    el.append(checkWrap);
  }

  const actions = node('div', 'kanban-card-actions');
  if (colIndex > 0) {
    const prevCol = kanbanState.kanban.columns[colIndex - 1];
    actions.append(iconBtn('kanban-icon-btn', 'ph-arrow-left', `Przenieś do: ${prevCol.title}`, (e) => {
      e.stopPropagation();
      moveKanbanCardToColumn(card.id, prevCol.id);
    }));
  }
  if (colIndex < totalCols - 1) {
    const nextCol = kanbanState.kanban.columns[colIndex + 1];
    actions.append(iconBtn('kanban-icon-btn', 'ph-arrow-right', `Przenieś do: ${nextCol.title}`, (e) => {
      e.stopPropagation();
      moveKanbanCardToColumn(card.id, nextCol.id);
    }));
  }
  if (editMode) {
    actions.append(iconBtn('kanban-icon-btn', 'ph-pencil-simple', 'Edytuj zadanie', (e) => {
      e.stopPropagation();
      openKanbanCardDialog(card.id);
    }));
  }
  if (actions.childElementCount > 0) {
    const footer = node('div', 'kanban-card-foot');
    footer.append(actions);
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

  $('kanbanSummary').textContent = cols.map((col) => `${col.title}: ${allCards.filter((c) => c.columnId === col.id).length}`).join(' · ') || 'Brak kolumn';
  renderMobileKanbanTabs(filteredCards);

  const board = $('kanbanBoard');
  board.replaceChildren();
  board.style.setProperty('--kanban-cols', String(Math.max(1, cols.length)));
  const slideClass = kanbanMobileSlideDir;
  kanbanMobileSlideDir = '';

  cols.forEach((col, colIndex) => {
    const isLastCol = cols.length > 1 && colIndex === cols.length - 1;
    const colEl = node('section', [
      'kanban-col',
      colIndex === selectedKanbanColIndex && 'mobile-active',
      colIndex === selectedKanbanColIndex && slideClass,
      isLastCol && 'is-done-col',
    ].filter(Boolean).join(' '));
    colEl.dataset.columnId = col.id;

    const colCards = filteredCards
      .filter((c) => c.columnId === col.id)
      .sort((a, b) => a.order - b.order || (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1));

    const head = node('div', 'kanban-col-head');
    const titleWrap = node('div', 'kanban-col-title-wrap');
    const colIcon = colIndex === 0 ? 'ph-circle-dashed' : isLastCol ? 'ph-check-circle' : 'ph-spinner-gap';
    titleWrap.append(node('i', `ph ${colIcon}`), node('h3', 'kanban-col-title', col.title), node('span', 'kanban-col-count', String(colCards.length)));
    head.append(titleWrap);

    if (editMode) head.append(iconBtn('kanban-col-add-btn', 'ph-plus', `Dodaj zadanie w kolumnie „${col.title}”`, () => openKanbanCardDialog(null, col.id)));
    colEl.append(head);

    const cardsContainer = node('div', 'kanban-cards');
    colEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', (e) => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drag-over'); });
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const cardId = draggedKanbanCardId || e.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const els = [...cardsContainer.querySelectorAll('.kanban-card:not(.dragging)')];
      let targetIdx = els.findIndex((cEl) => {
        const r = cEl.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (targetIdx < 0) targetIdx = els.length;
      moveKanbanCardToColumn(cardId, col.id, targetIdx);
    });

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
      for (const card of colCards) cardsContainer.append(renderKanbanCard(card, colIndex, cols.length, isLastCol));
    }

    colEl.append(cardsContainer);
    board.append(colEl);
  });
}

// --- Okno dodawania / edycji zadania Kanban ----------------------------------

function populateKanbanCardFormSelects(selectedSubject = '', selectedCategory = 'Projekt', selectedColumnId = '') {
  const colSelect = $('kanbanCardColumn');
  colSelect.replaceChildren();
  for (const col of kanbanState.kanban.columns) {
    const opt = node('option', '', col.title);
    opt.value = col.id;
    colSelect.append(opt);
  }
  if (selectedColumnId && kanbanState.kanban.columns.some((c) => c.id === selectedColumnId)) colSelect.value = selectedColumnId;

  const subjSelect = $('kanbanCardSubjectSelect');
  subjSelect.replaceChildren();
  const knownSubjects = getKnownSubjectNames();
  const opts = [['', '— Ogólne / bez przedmiotu —'], ...knownSubjects.map((n) => [n, n]), [KANBAN_CUSTOM_SUBJECT, '✎ Inny przedmiot / projekt (wpisz)...']];
  for (const [val, label] of opts) {
    const opt = node('option', '', label);
    opt.value = val;
    subjSelect.append(opt);
  }

  syncCustomSelect(subjSelect, $('kanbanCardSubjectCustom'), selectedSubject, KANBAN_CUSTOM_SUBJECT, '');
  syncCustomSelect($('kanbanCardCategorySelect'), $('kanbanCardCategoryCustom'), selectedCategory, KANBAN_CUSTOM_CATEGORY, '');
}

function renderDraftChecklist() {
  const container = $('kanbanChecklistItems');
  container.replaceChildren();
  draftChecklist.forEach((item, idx) => {
    const row = node('div', 'kanban-draft-checkrow');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.onchange = () => { item.done = cb.checked; };

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = item.text;
    textInput.maxLength = 200;
    textInput.oninput = () => { item.text = textInput.value; };

    const removeBtn = iconBtn('danger kanban-icon-btn', 'ph-x', 'Usuń podpunkt', () => {
      draftChecklist.splice(idx, 1);
      renderDraftChecklist();
    });
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

  const fallbackColId = defaultColumnId || kanbanState.kanban.columns[selectedKanbanColIndex]?.id || kanbanState.kanban.columns[0]?.id;

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
    populateKanbanCardFormSelects(activeFilterSubj && activeFilterSubj !== '__none__' ? activeFilterSubj : '', 'Projekt', fallbackColId);
    draftChecklist = [];
    $('deleteKanbanCardBtn').hidden = true;
  }

  renderDraftChecklist();
  showDialogModal($('kanbanCardDialog'));
}

function saveKanbanCard(event) {
  event.preventDefault();
  try {
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
    const subjectName = subjVal === KANBAN_CUSTOM_SUBJECT ? $('kanbanCardSubjectCustom').value.trim() : subjVal.trim();
    const catVal = $('kanbanCardCategorySelect').value;
    const category = catVal === KANBAN_CUSTOM_CATEGORY ? $('kanbanCardCategoryCustom').value.trim() : catVal.trim();

    const checklist = draftChecklist
      .map((item) => ({ id: item.id || uid(), text: item.text.trim(), done: !!item.done }))
      .filter((item) => item.text.length > 0);

    mutateKanban((kanban) => {
      if (editingKanbanCardId) {
        const existing = kanban.cards.find((c) => c.id === editingKanbanCardId);
        if (!existing) return;
        const colChanged = existing.columnId !== columnId;
        Object.assign(existing, { title, columnId, priority, dueDate, description, subjectName, category, checklist });
        if (colChanged) existing.order = kanban.cards.filter((c) => c.columnId === columnId && c.id !== existing.id).length;
      } else {
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
          order: kanban.cards.filter((c) => c.columnId === columnId).length,
        });
      }
    });
    $('kanbanCardDialog').close();
  } catch (err) {
    $('kanbanCardError').textContent = err.message;
  }
}

function deleteKanbanCard() {
  if (!editingKanbanCardId || !confirm('Czy na pewno usunąć to zadanie z tablicy Kanban?')) return;
  try {
    mutateKanban((kanban) => { kanban.cards = kanban.cards.filter((c) => c.id !== editingKanbanCardId); });
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

  const moveCol = (idx, delta) => {
    mutateKanban((kanban) => {
      [kanban.columns[idx], kanban.columns[idx + delta]] = [kanban.columns[idx + delta], kanban.columns[idx]];
    });
    renderKanbanColumnsList();
  };

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
      if (!nextTitle) { input.value = col.title; return; }
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
    if (idx > 0) actions.append(iconBtn('kanban-icon-btn', 'ph-arrow-up', 'Przesuń w lewo / wyżej', () => moveCol(idx, -1)));
    if (idx < cols.length - 1) actions.append(iconBtn('kanban-icon-btn', 'ph-arrow-down', 'Przesuń w prawo / niżej', () => moveCol(idx, 1)));

    const delBtn = node('button', 'danger', count > 0 ? `Zajęta (${count})` : 'Usuń');
    delBtn.type = 'button';
    delBtn.disabled = cols.length <= 1 || count > 0;
    delBtn.onclick = () => {
      try {
        mutateKanban((kanban) => { kanban.columns = kanban.columns.filter((c) => c.id !== col.id); });
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
      if (kanban.columns.length >= 12) throw Error('Maksymalnie 12 kolumn w tablicy Kanban.');
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
  if (!confirm(`Usunąć wszystkie zadania (${doneCards.length}) z kolumny „${doneCol.title}”?`)) return;
  mutateKanban((kanban) => { kanban.cards = kanban.cards.filter((c) => c.columnId !== doneCol.id); });
  setStatus(`Usunięto ${doneCards.length} ukończonych zadań z kolumny „${doneCol.title}”.`);
}

function resetKanbanBoard() {
  if (!confirm('Czy na pewno wyczyścić całą tablicę Kanban do domyślnych 3 kolumn i usunąć wszystkie zadania?')) return;
  mutateKanban((kanban) => { Object.assign(kanban, emptyKanban()); });
  setStatus('Tablica Kanban została zresetowana. Kliknij „Zapisz tablicę w chmurze”, jeśli chcesz nadpisać też plik kanban.json w chmurze.');
}

// --- Nawigacja, import i eksport ---------------------------------------------

function showWeek(newWeek) {
  week = newWeek;
  render();
}

function exportActiveView() {
  const isKanban = activeView === 'kanban';
  const payload = isKanban ? kanbanState.kanban : state.plan;
  const baseName = getActiveId(isKanban ? 'kanban' : 'plan') || (isKanban ? 'kanban' : 'plan');
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));

  const link = node('a');
  link.href = url;
  link.download = `${baseName}-${today()}.json`;
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
    const looksLikeKanban = Array.isArray(parsed?.columns) && Array.isArray(parsed?.cards);
    const target = looksLikeKanban || activeView === 'kanban' ? 'kanban' : 'plan';
    const isKanban = target === 'kanban';
    const validated = TARGETS[target].validate(parsed);

    if (!confirm(`Zastąpić lokalny ${isKanban ? 'zapis tablicy Kanban' : 'plan zajęć'} danymi z pliku JSON? W razie potrzeby najpierw wyeksportuj obecną kopię.`)) return;
    if (activeView !== (isKanban ? 'kanban' : 'calendar')) setActiveView(isKanban ? 'kanban' : 'calendar');
    mutateTarget(target, (current) => Object.assign(current, validated));
    setStatus(isKanban ? 'Zaimportowano tablicę Kanban z pliku JSON.' : 'Zaimportowano plan zajęć z pliku JSON.');
  } catch (err) {
    setStatus(err instanceof SyntaxError ? 'Plik nie jest prawidłowym JSON-em.' : err.message);
  } finally {
    input.value = '';
  }
}

// --- Klucz dostępu i synchronizacja z chmurą (ręczna i auto-sync) ------------

function getActiveId(target) {
  try {
    return (localStorage.getItem(TARGETS[target].idKey) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function updateConnectionPreviews() {
  const setPreview = (elId, resolver, rawVal) => {
    try {
      $(elId).innerHTML = `Plik w chmurze: <code>${resolver(rawVal)}</code>`;
    } catch {
      $(elId).textContent = 'Dozwolone tylko litery bez polskich znaków, cyfry, - i _';
    }
  };
  setPreview('planKeyPreview', resolvePlanKey, ($('planId')?.value || '').trim().toLowerCase());
  setPreview('kanbanKeyPreview', resolveKanbanKey, ($('kanbanId')?.value || '').trim().toLowerCase());
}

function updateConnectionButtonLabel() {
  const btn = $('connection');
  if (!btn) return;
  const planId = getActiveId('plan');
  const kanbanId = getActiveId('kanban');
  btn.innerHTML = '<i class="ph ph-key"></i> Ustawienia chmury';
  btn.title = `Plik planu: ${planId ? `${planId}.json` : 'plan.json'} · Plik Kanban: ${kanbanId ? `${kanbanId}.json` : 'kanban.json'}`;
}

function isAutoSyncEnabled() {
  try {
    const raw = localStorage.getItem(AUTO_SYNC_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function hasCloudToken() {
  try {
    return (localStorage.getItem(TOKEN_KEY) || '').trim().length >= MIN_TOKEN_LENGTH;
  } catch {
    return false;
  }
}

function updateCloudStatusIndicator(stateOverride = null, detailOverride = null) {
  const badge = $('cloudStatusBadge');
  const labelEl = $('cloudStatusText');
  if (!badge || !labelEl) return;

  if (detailOverride !== null) cloudSyncDetail = detailOverride;

  let effectiveState = 'synced';
  let text = 'Zsynchronizowano';
  let title = `Wszystkie zmiany zapisane w chmurze${cloudSyncDetail ? ` (${cloudSyncDetail})` : ''}`;

  if (!hasCloudToken()) {
    effectiveState = 'unconfigured';
    text = 'Chmura';
    title = 'Brak klucza dostępu — kliknij, aby skonfigurować synchronizację z chmurą';
  } else if (stateOverride === 'error' || cloudSyncState === 'error') {
    effectiveState = 'error';
    text = 'Błąd synchr.';
    title = cloudSyncDetail || 'Błąd synchronizacji lub konflikt wersji w chmurze — kliknij, aby sprawdzić ustawienia';
  } else if (autoSyncInFlight > 0 || planAutoSaveTimer !== null || kanbanAutoSaveTimer !== null) {
    effectiveState = 'pending';
    text = 'Zapisywanie…';
    title = 'Trwa automatyczna synchronizacja danych z chmurą…';
  } else if (state.dirty || kanbanState.dirty) {
    effectiveState = 'dirty';
    text = 'Niezapisane';
    title = isAutoSyncEnabled()
      ? 'Masz lokalne zmiany oczekujące na automatyczny zapis w chmurze'
      : 'Masz lokalne zmiany — auto-synchronizacja jest wyłączona (zapisz ręcznie w Menu)';
  } else if (!isAutoSyncEnabled()) {
    text = 'Auto-synchr. wył.';
    title = 'Automatyczna synchronizacja wyłączona — brak niezapisanych zmian';
  }

  badge.dataset.state = effectiveState;
  labelEl.textContent = text;
  badge.title = title;
}

function openConnectionDialog() {
  try {
    $('planId').value = getActiveId('plan');
    $('kanbanId').value = getActiveId('kanban');
    $('token').value = localStorage.getItem(TOKEN_KEY) || '';
    $('autoSyncEnabled').checked = isAutoSyncEnabled();
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
    const planKey = resolvePlanKey(rawPlanId);
    const kanbanKey = resolveKanbanKey(rawKanbanId);

    const token = $('token').value.trim();
    if (token && token.length < MIN_TOKEN_LENGTH) throw Error(`Klucz musi mieć minimum ${MIN_TOKEN_LENGTH} znaki.`);

    const autoSyncEnabled = $('autoSyncEnabled').checked;
    const prevPlanId = getActiveId('plan');
    const prevKanbanId = getActiveId('kanban');

    const saveOrRemove = (key, val) => (val ? localStorage.setItem(key, val) : localStorage.removeItem(key));
    saveOrRemove(PLAN_ID_KEY, rawPlanId);
    saveOrRemove(KANBAN_ID_KEY, rawKanbanId);
    saveOrRemove(TOKEN_KEY, token);
    localStorage.setItem(AUTO_SYNC_KEY, String(autoSyncEnabled));

    if (rawPlanId !== prevPlanId) persistTarget('plan', { ...clone(state), etag: null });
    if (rawKanbanId !== prevKanbanId) persistTarget('kanban', { ...clone(kanbanState), etag: null });

    cloudSyncState = hasCloudToken() ? 'synced' : 'unconfigured';
    updateConnectionButtonLabel();
    updateCloudStatusIndicator();
    $('connectionError').textContent = '';
    $('connectionDialog').close();
    setStatus(`Zapisano ustawienia chmury (plan: ${planKey} · tablica Kanban: ${kanbanKey} · auto-synchr.: ${autoSyncEnabled ? 'wł.' : 'wył.'}).`);
    if (token && autoSyncEnabled) autoPullFromCloud(true);
  } catch (err) {
    $('connectionError').textContent = err.message;
  }
}

const setButtonsDisabled = (disabled) => {
  for (const button of document.querySelectorAll('button')) button.disabled = disabled;
};

/** Wspólny klient API Workera (/api/plan i /api/kanban) dla sync ręcznego i automatycznego. */
async function callApi(
  direction,
  token,
  planId,
  target = 'plan',
  { silent = false, keepalive = false, payloadJson = null, etagOverride = undefined, ifNoneMatchEtag = null } = {},
) {
  const cfg = TARGETS[target];
  const st = cfg.getState();
  const url = planId ? `${cfg.apiUrl}?id=${encodeURIComponent(planId)}` : cfg.apiUrl;
  const headers = { Authorization: 'Bearer ' + token };
  const options = { method: 'GET', headers, cache: 'no-store', keepalive: Boolean(keepalive) };
  if (!keepalive) options.signal = AbortSignal.timeout(API_TIMEOUT_MS);

  if (direction === 'pull' && ifNoneMatchEtag) headers['If-None-Match'] = `"${ifNoneMatchEtag}"`;

  if (direction === 'push') {
    options.method = 'PUT';
    options.body = payloadJson ?? JSON.stringify(st[cfg.prop]);
    headers['Content-Type'] = 'application/json';
    const etag = etagOverride !== undefined ? etagOverride : st.etag;
    if (etag) headers['If-Match'] = `"${etag}"`;
    else headers['If-None-Match'] = '*';
  }

  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(silent ? 'API nie jest dostępne.' : 'API nie jest dostępne. Uruchom projekt przez npm run dev albo wdróż Worker.');
  }

  if (response.status === 409) {
    if (silent) {
      const err = Error(data.error || 'Konflikt wersji w chmurze.');
      err.isConflict = true;
      throw err;
    }
    if (direction === 'push' && etagOverride === undefined) {
      if (confirm(`W chmurze dla ${cfg.nounGen} „${planId || 'domyślny'}” znajduje się już inna zapisana wersja. Czy chcesz ją nadpisać swoją obecną wersją lokalną?`)) {
        const remote = await callApi('pull', token, planId, target);
        return callApi('push', token, planId, target, { etagOverride: remote.etag });
      }
    }
  }

  if (!response.ok) throw Error(data.error || (silent ? 'Błąd połączenia z chmurą.' : 'Błąd połączenia.'));
  return data;
}

async function runAutoPush(target, { keepalive = false } = {}) {
  const cfg = TARGETS[target];
  if (busy || storageBlocked || !hasCloudToken() || !isAutoSyncEnabled() || !cfg.getState().dirty) {
    updateCloudStatusIndicator();
    return;
  }

  const token = (localStorage.getItem(TOKEN_KEY) || '').trim();
  const activeId = getActiveId(target);
  const fileKey = cfg.resolveKey(activeId);
  const st = cfg.getState();
  const snapshotJson = JSON.stringify(st[cfg.prop]);

  autoSyncInFlight++;
  if (cloudSyncState === 'error') cloudSyncState = 'pending';
  updateCloudStatusIndicator();

  try {
    const data = await callApi('push', token, activeId, target, {
      silent: true,
      keepalive,
      payloadJson: snapshotJson,
      etagOverride: st.etag,
    });

    if (!storageBlocked) {
      const current = cfg.getState();
      const stillSame = JSON.stringify(current[cfg.prop]) === snapshotJson;
      const next = clone(current);
      next.etag = data.etag;
      if (stillSame) next.dirty = false;
      persistTarget(target, next);
      if (!stillSame) scheduleAutoPush(target);
    }

    const timeLabel = new Date().toLocaleTimeString('pl-PL');
    cloudSyncState = 'synced';
    cloudSyncDetail = timeLabel;
    if (!state.dirty && !kanbanState.dirty) setStatus(`Auto-zapis w chmurze (${fileKey}) · ${timeLabel}.`);
  } catch (err) {
    cloudSyncState = 'error';
    cloudSyncDetail = err.isConflict ? `Konflikt wersji (${fileKey}) — pobierz lub nadpisz ręcznie w Menu` : `${err.message}`;
    setStatus(
      err.isConflict
        ? `Konflikt wersji w chmurze (${fileKey}) — kliknij „Pobierz z chmury” lub „Zapisz w chmurze” w Menu.`
        : `Błąd auto-zapisu (${fileKey}): ${err.message}`,
    );
  } finally {
    autoSyncInFlight = Math.max(0, autoSyncInFlight - 1);
    updateCloudStatusIndicator();
  }
}

function scheduleAutoPush(target) {
  if (cloudSyncState === 'error') cloudSyncState = 'dirty';
  if (!hasCloudToken() || !isAutoSyncEnabled() || storageBlocked) {
    updateCloudStatusIndicator();
    return;
  }
  const cfg = TARGETS[target];
  if (cfg.getTimer() !== null) clearTimeout(cfg.getTimer());
  cfg.setTimer(setTimeout(() => {
    cfg.setTimer(null);
    runAutoPush(target);
  }, AUTO_SAVE_DELAY_MS));
  updateCloudStatusIndicator();
}

function flushPendingAutoPushKeepalive() {
  if (!hasCloudToken() || !isAutoSyncEnabled() || storageBlocked || busy) return;
  for (const target of ['plan', 'kanban']) {
    const cfg = TARGETS[target];
    if (cfg.getTimer() !== null) {
      clearTimeout(cfg.getTimer());
      cfg.setTimer(null);
    }
    if (cfg.getState().dirty) runAutoPush(target, { keepalive: true });
  }
}

async function autoPullTarget(target, token) {
  const cfg = TARGETS[target];
  const st = cfg.getState();
  if (st.dirty || cfg.getTimer() !== null) {
    if (st.dirty && cfg.getTimer() === null) scheduleAutoPush(target);
    return false;
  }
  const data = await callApi('pull', token, getActiveId(target), target, {
    silent: true,
    ifNoneMatchEtag: st.etag,
  });
  const latest = cfg.getState();
  if (latest.dirty || cfg.getTimer() !== null || busy || storageBlocked) return false;
  if (data.unchanged) return false;

  if (data.etag !== null && data.etag !== latest.etag) {
    const validated = cfg.validate(data[cfg.prop]);
    persistTarget(target, { [cfg.prop]: validated, etag: data.etag, dirty: false });
    cfg.onAfterPull();
    return true;
  }
  if (data.etag === null && cfg.hasData(latest[cfg.prop])) {
    persistTarget(target, { ...clone(latest), dirty: true });
    scheduleAutoPush(target);
  }
  return false;
}

async function autoPullFromCloud(isInitial = false) {
  if (!hasCloudToken() || !isAutoSyncEnabled() || busy || autoSyncInFlight > 0 || autoPullInFlight || storageBlocked || draggedKanbanCardId) {
    updateCloudStatusIndicator();
    return;
  }
  if (!isInitial && Date.now() - lastAutoPullAt < AUTO_PULL_COOLDOWN_MS) return;

  lastAutoPullAt = Date.now();
  const token = (localStorage.getItem(TOKEN_KEY) || '').trim();
  autoPullInFlight = true;

  try {
    const pulledPlan = await autoPullTarget('plan', token);
    const pulledKanban = await autoPullTarget('kanban', token);
    const timeLabel = new Date().toLocaleTimeString('pl-PL');
    cloudSyncState = 'synced';
    cloudSyncDetail = timeLabel;
    if (pulledPlan || pulledKanban) {
      const parts = [pulledPlan && 'plan zajęć', pulledKanban && 'tablicę Kanban'].filter(Boolean);
      setStatus(`Auto-synchronizacja: pobrano z chmury (${parts.join(' i ')}) · ${timeLabel}.`);
    }
  } catch (err) {
    cloudSyncState = 'error';
    cloudSyncDetail = err.message;
  } finally {
    autoPullInFlight = false;
    updateCloudStatusIndicator();
  }
}

async function sync(direction) {
  if (busy) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { openConnectionDialog(); return; }

    const target = activeView === 'kanban' ? 'kanban' : 'plan';
    const cfg = TARGETS[target];
    const activeId = getActiveId(target);
    const fileKey = cfg.resolveKey(activeId);

    if (direction === 'pull' && cfg.getState().dirty &&
      !confirm(`Pobranie zastąpi niezapisane lokalne zmiany (${cfg.nounAcc}). Wyeksportuj je najpierw do pliku JSON, jeśli chcesz je zachować. Kontynuować?`)) {
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setStatus(direction === 'pull' ? `Pobieranie z chmury: ${fileKey}…` : `Zapisywanie w chmurze: ${fileKey}…`);

    const data = await callApi(direction, token, activeId, target);
    if (cfg.getTimer() !== null) {
      clearTimeout(cfg.getTimer());
      cfg.setTimer(null);
    }

    const next = clone(cfg.getState());
    if (direction === 'pull') next[cfg.prop] = cfg.validate(data[cfg.prop]);
    next.etag = data.etag;
    next.dirty = false;
    persistTarget(target, next);
    cfg.onAfterPull();

    const timeLabel = new Date().toLocaleTimeString('pl-PL');
    cloudSyncState = 'synced';
    cloudSyncDetail = timeLabel;
    setStatus(`Zsynchronizowano ${cfg.label} (${fileKey}) · ${timeLabel}.`);
  } catch (err) {
    cloudSyncState = 'error';
    cloudSyncDetail = err.message;
    setStatus(err.name === 'TimeoutError'
      ? 'Przekroczono czas połączenia. Dane lokalne pozostały bez zmian.'
      : err.message + ' Lokalna kopia pozostaje dostępna.');
  } finally {
    busy = false;
    setButtonsDisabled(false);
    updateCloudStatusIndicator();
  }
}

// --- Podpięcie zdarzeń -------------------------------------------------------

function bindEvents() {
  const closeAnd = (fn) => () => {
    closeToolbarDropdowns();
    setMobileMenuOpen(false);
    fn();
  };

  for (const details of document.querySelectorAll('.toolbar-dropdown')) {
    details.addEventListener('toggle', () => {
      if (details.open) closeToolbarDropdowns(details);
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target?.closest?.('.toolbar-dropdown')) closeToolbarDropdowns();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeToolbarDropdowns();
  });

  $('tabCalendar').onclick = () => setActiveView('calendar');
  $('tabKanban').onclick = () => setActiveView('kanban');
  $('cloudStatusBadge').onclick = closeAnd(openConnectionDialog);
  $('liveClockBadge').onclick = () => {
    const t = today();
    if (activeView !== 'calendar') setActiveView('calendar');
    selectedDayIndex = weekdayIndex(t);
    showWeek(monday(t));
  };

  $('menuToggle').onclick = () => setMobileMenuOpen(!$('navPanel').classList.contains('open'));
  $('editModeToggle').onclick = () => setEditMode(!editMode);
  $('addEvent').onclick = closeAnd(() => openEventDialog(null, addDays(week, selectedDayIndex)));

  // Kanban
  $('addKanbanCardBtn').onclick = closeAnd(() => openKanbanCardDialog());
  $('manageKanbanColsBtn').onclick = closeAnd(openKanbanColumnsDialog);
  $('clearKanbanDoneBtn').onclick = closeAnd(clearKanbanDone);
  $('resetKanbanBtn').onclick = closeAnd(resetKanbanBoard);
  $('kanbanFilterSubject').onchange = renderKanban;
  $('kanbanFilterPriority').onchange = renderKanban;
  $('kanbanSearch').oninput = renderKanban;

  $('kanbanCardSubjectSelect').onchange = () => toggleCustomInput($('kanbanCardSubjectSelect'), $('kanbanCardSubjectCustom'), KANBAN_CUSTOM_SUBJECT, true);
  $('kanbanCardCategorySelect').onchange = () => toggleCustomInput($('kanbanCardCategorySelect'), $('kanbanCardCategoryCustom'), KANBAN_CUSTOM_CATEGORY, true);
  $('addKanbanCheckItemBtn').onclick = addDraftChecklistItem;
  $('kanbanNewCheckItem').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addDraftChecklistItem(); }
  });
  $('kanbanCardForm').onsubmit = saveKanbanCard;
  $('deleteKanbanCardBtn').onclick = deleteKanbanCard;
  $('kanbanColumnForm').onsubmit = addKanbanColumn;
  $('kanbanDetailsEditBtn').onclick = () => {
    const id = detailsKanbanCardId;
    $('kanbanDetailsDialog').close();
    if (id) openKanbanCardDialog(id);
  };

  // Swipe w kolumnach Kanban na telefonie
  let kanbanTouchX = null;
  let kanbanTouchY = null;
  $('kanbanBoard').addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && window.innerWidth <= 768) {
      kanbanTouchX = e.touches[0].clientX;
      kanbanTouchY = e.touches[0].clientY;
    }
  }, { passive: true });
  $('kanbanBoard').addEventListener('touchend', (e) => {
    if (kanbanTouchX === null || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - kanbanTouchX;
    const dy = e.changedTouches[0].clientY - kanbanTouchY;
    kanbanTouchX = kanbanTouchY = null;
    const totalCols = kanbanState.kanban.columns.length;
    if (window.innerWidth <= 768 && totalCols > 1 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0 && selectedKanbanColIndex < totalCols - 1) { kanbanMobileSlideDir = 'slide-next'; selectedKanbanColIndex++; renderKanban(); }
      else if (dx > 0 && selectedKanbanColIndex > 0) { kanbanMobileSlideDir = 'slide-prev'; selectedKanbanColIndex--; renderKanban(); }
    }
  }, { passive: true });

  // Formularz zajęć, przedmiotów, czyszczenia i struktury roku
  $('subject').onchange = updateSubjectSelectionFields;
  $('typeSelect').onchange = () => toggleCustomInput($('typeSelect'), $('typeCustom'), CUSTOM_TYPE_VALUE, true);
  $('start').onchange = () => {
    const startVal = $('start').value;
    if (!startVal) return;
    if (!$('end').value || $('end').value <= startVal) {
      const duration = $('subject').value === CUSTOM_SUBJECT_VALUE ? 60 : 90;
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

  $('subjects').onclick = closeAnd(() => openSubjectDialog());
  $('subjectForm').onsubmit = saveSubject;
  $('newSubject').onclick = resetSubjectForm;

  $('bulkManageBtn').onclick = closeAnd(openBulkDialog);
  $('reconcileBtn').onclick = runReconcile;
  $('clearEventsBtn').onclick = clearAllEvents;
  $('clearAllBtn').onclick = clearEntireCalendar;

  $('academicYearBtn').onclick = closeAnd(openAcademicYearDialog);
  $('academicYearForm').onsubmit = saveSpecialDay;
  $('specialDayType').onchange = updateSpecialDayTypeFields;
  $('rectorFullDay').onchange = updateSpecialDayTypeFields;

  for (const button of document.querySelectorAll('[data-close]')) {
    button.onclick = () => button.closest('dialog').close();
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', syncModalScrollLock);
    dialog.addEventListener('cancel', () => setTimeout(syncModalScrollLock, 0));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  // Nawigacja tygodniowa i swipe na kalendarzu
  $('prev').onclick = () => showWeek(addDays(week, -7));
  $('next').onclick = () => showWeek(addDays(week, 7));
  $('today').onclick = () => {
    const t = today();
    selectedDayIndex = weekdayIndex(t);
    showWeek(monday(t));
  };
  $('jump').onchange = () => {
    const val = $('jump').value;
    if (val) { selectedDayIndex = weekdayIndex(val); showWeek(monday(val)); }
  };

  let touchStartX = null;
  let touchStartY = null;
  let isHorizontalSwipe = null;
  const calendarEl = $('calendar');

  const resetActiveDayDrag = () => {
    const activeDay = calendarEl.querySelector('.day.mobile-active');
    if (activeDay) activeDay.style.transform = activeDay.style.opacity = activeDay.style.transition = '';
  };

  calendarEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && window.innerWidth <= 768) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      isHorizontalSwipe = null;
    }
  }, { passive: true });
  calendarEl.addEventListener('touchmove', (e) => {
    if (touchStartX === null || e.touches.length !== 1 || window.innerWidth > 768) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (isHorizontalSwipe === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.3;
    if (isHorizontalSwipe) {
      const activeDay = calendarEl.querySelector('.day.mobile-active');
      if (activeDay) {
        const dampedX = Math.max(-90, Math.min(90, dx * 0.38));
        activeDay.style.transition = 'none';
        activeDay.style.transform = `translate3d(${dampedX.toFixed(1)}px, 0, 0)`;
        activeDay.style.opacity = String((1 - Math.min(1, Math.abs(dx) / 220) * 0.25).toFixed(2));
      }
    }
  }, { passive: true });
  calendarEl.addEventListener('touchcancel', () => {
    touchStartX = touchStartY = isHorizontalSwipe = null;
    resetActiveDayDrag();
  });
  calendarEl.addEventListener('touchend', (e) => {
    if (touchStartX === null || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartX = touchStartY = isHorizontalSwipe = null;

    if (window.innerWidth <= 768 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) {
        mobileSlideDir = 'slide-next';
        if (selectedDayIndex < 6) { selectedDayIndex++; render(); }
        else { selectedDayIndex = 0; showWeek(addDays(week, 7)); }
      } else {
        mobileSlideDir = 'slide-prev';
        if (selectedDayIndex > 0) { selectedDayIndex--; render(); }
        else { selectedDayIndex = 6; showWeek(addDays(week, -7)); }
      }
    } else {
      resetActiveDayDrag();
    }
  }, { passive: true });

  // Zegar, widoczność karty, auto-sync i pliki
  setInterval(updateLiveTimeIndicator, 10_000);
  setInterval(() => {
    if (!document.hidden) autoPullFromCloud(false);
  }, AUTO_PULL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPendingAutoPushKeepalive();
    else { updateLiveTimeIndicator(); autoPullFromCloud(false); }
  });
  window.addEventListener('focus', () => autoPullFromCloud(false));
  window.addEventListener('online', () => autoPullFromCloud(true));
  window.addEventListener('pagehide', flushPendingAutoPushKeepalive);
  window.addEventListener('beforeunload', (e) => {
    if (planAutoSaveTimer !== null || kanbanAutoSaveTimer !== null || state.dirty || kanbanState.dirty) flushPendingAutoPushKeepalive();
    if (autoSyncInFlight > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', () => requestAnimationFrame(refreshSpecialDayMarquees));

  $('export').onclick = closeAnd(exportActiveView);
  $('importButton').onclick = closeAnd(() => $('import').click());
  $('import').onchange = importActiveView;
  $('connection').onclick = closeAnd(openConnectionDialog);
  $('planId').oninput = updateConnectionPreviews;
  $('kanbanId').oninput = updateConnectionPreviews;
  $('connectionForm').onsubmit = saveConnection;
  $('pull').onclick = () => { closeToolbarDropdowns(); sync('pull'); };
  $('push').onclick = () => { closeToolbarDropdowns(); sync('push'); };

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
autoPullFromCloud(true);
