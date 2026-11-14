// Wspólny model danych planu i tablicy Kanban — używany w przeglądarce (app.js) oraz w Workerze (worker.js).

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  subjects: 500,
  events: 10_000,
  eventsPerSeries: 500,
  subjectName: 120,
  subjectDetails: 2000,
  type: 60,
  room: 120,
  teacher: 120,
  notes: 2000,
  specialDays: 500,
  dayLabel: 120,
  kanbanColumns: 12,
  kanbanColumnTitle: 60,
  kanbanCards: 2000,
  kanbanCardTitle: 160,
  kanbanCardDesc: 2000,
  kanbanChecklistItems: 50,
  kanbanChecklistText: 200,
};

const MIN_DATE = '2000-01-01';
const MAX_DATE = '2100-12-31';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
export const PLAN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,60}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DAY_OF_WEEK_PATTERN = /^(mon|tue|wed|thu|fri|sat|sun)$/;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 86_400_000;
const KANBAN_PRIORITIES = new Set(['low', 'medium', 'high']);

function resolveStorageKey(rawId, defaultFile, folder) {
  const cleaned = (rawId ?? '').trim();
  if (!cleaned || cleaned.toLowerCase() === 'default') return defaultFile;
  if (!PLAN_ID_PATTERN.test(cleaned)) {
    throw Error('Nazwa planu może zawierać tylko litery (bez polskich znaków), cyfry, myślnik i podkreślenie (maks. 60 znaków).');
  }
  return `${folder}/${cleaned.toLowerCase()}.json`;
}

/** Wyznacza klucz obiektu planu w R2 na podstawie opcjonalnej nazwy/ID. */
export const resolvePlanKey = (rawId) => resolveStorageKey(rawId, 'plan.json', 'plans');

/** Wyznacza klucz obiektu tablicy Kanban w R2 na podstawie opcjonalnej nazwy/ID. */
export const resolveKanbanKey = (rawId) => resolveStorageKey(rawId, 'kanban.json', 'kanban');

export const DEFAULT_KANBAN_COLUMNS = [
  { id: 'todo', title: 'Do zrobienia' },
  { id: 'in_progress', title: 'W trakcie' },
  { id: 'done', title: 'Zrobione' },
];

export const emptyKanban = () => ({
  schemaVersion: SCHEMA_VERSION,
  columns: DEFAULT_KANBAN_COLUMNS.map((col) => ({ ...col })),
  cards: [],
});

export const emptyPlan = () => ({
  schemaVersion: SCHEMA_VERSION,
  subjects: [],
  events: [],
  academicYear: { specialDays: [] },
});

/** Sprawdza, czy tekst to istniejąca data w formacie RRRR-MM-DD (np. odrzuca 2026-02-31). */
export function validDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || value < MIN_DATE || value > MAX_DATE) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Dodaje `days` dni do daty RRRR-MM-DD w południe UTC (bez wpływu zmiany czasu). */
export function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Zwraca poniedziałek tygodnia, do którego należy podana data. */
export function monday(date) {
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Zwraca klucz dnia tygodnia ('mon'..'sun') dla podanej daty. */
export const getDayOfWeekKey = (date) => WEEKDAY_KEYS[new Date(date + 'T12:00:00Z').getUTCDay()];

/** Sprawdza, czy podana data przypada w weekend (sobota lub niedziela). */
export function isWeekend(date) {
  const key = getDayOfWeekKey(date);
  return key === 'sat' || key === 'sun';
}

const weeksBetween = (a, b) => Math.round((Date.parse(monday(b)) - Date.parse(monday(a))) / (7 * DAY_MS));
const specialDayMap = (academicYear) => new Map((academicYear?.specialDays || []).map((sd) => [sd.date, sd]));

/**
 * Który dzień planu obowiązuje w danej dacie według struktury roku:
 * null (dzień wolny/sesja/weekend), targetDay (zamiana planu) lub zwykły dzień tygodnia.
 */
export function effectiveDayKey(date, academicYear, map = specialDayMap(academicYear)) {
  const special = map.get(date);
  if (special?.type === 'holiday' || special?.type === 'session') return null;
  if (special?.type === 'swap') return special.targetDay;
  return isWeekend(date) ? null : getDayOfWeekKey(date);
}

/** Zwraca wpis dnia wolnego dla daty (w tym weekendy bez zamiany/sesji) albo null. */
export function holidayFor(date, academicYear) {
  const special = specialDayMap(academicYear).get(date);
  if (special?.type === 'holiday') return special;
  if (special?.type === 'swap' || special?.type === 'session') return null;
  return isWeekend(date) ? { date, type: 'holiday', label: 'Weekend', isWeekend: true } : null;
}

function holidayError(date, holiday) {
  const reason = holiday.label ? ` (${holiday.label})` : '';
  return Error(`${date} to dzień wolny${reason}. W dni wolne i weekendy można dodawać tylko wydarzenia własne (poza przedmiotem).`);
}

/** Generuje listę dat spotkań dla trybów 'once', 'weekly', 'biweekly' i 'manual'. */
export function datesFor(start, until, mode, manual = '', academicYear = null, applyAcademicYear = true, isCustom = false) {
  if (!validDate(start)) throw Error('Wybierz prawidłową datę.');
  const enforceHolidays = applyAcademicYear && !isCustom;
  const year = enforceHolidays ? academicYear : null;
  const map = specialDayMap(year);

  if (mode === 'once') {
    const holiday = enforceHolidays ? holidayFor(start, year) : null;
    if (holiday) throw holidayError(start, holiday);
    return [start];
  }

  if (mode === 'manual') {
    const dates = [...new Set(manual.split(/[\s,;]+/).filter(Boolean))].sort();
    if (!dates.length || dates.length > LIMITS.eventsPerSeries || !dates.every(validDate)) {
      throw Error('Podaj daty w formacie RRRR-MM-DD, oddzielone przecinkami.');
    }
    const allowed = enforceHolidays ? dates.filter((d) => !holidayFor(d, year)) : dates;
    if (!allowed.length) throw Error('Wszystkie wskazane daty przypadają na dni wolne.');
    return allowed;
  }

  if (!['weekly', 'biweekly'].includes(mode) || !validDate(until) || until < start) {
    throw Error('Podaj datę końca serii nie wcześniejszą niż początek.');
  }

  const seriesDay = getDayOfWeekKey(start);
  const everyWeeks = mode === 'weekly' ? 1 : 2;
  const result = [];

  for (let date = start; date <= until; date = addDays(date, 1)) {
    const dayKey = enforceHolidays ? effectiveDayKey(date, year, map) : getDayOfWeekKey(date);
    if (dayKey !== seriesDay || weeksBetween(start, date) % everyWeeks !== 0) continue;
    if (result.length >= LIMITS.eventsPerSeries) throw Error(`Maksymalnie ${LIMITS.eventsPerSeries} spotkań w jednej serii.`);
    result.push(date);
  }

  if (!result.length) throw Error('W wybranym okresie nie ma żadnego terminu — wszystkie przypadają na dni wolne.');
  return result;
}

/** Dopasowuje istniejące serie powtarzalne (min. 2 spotkania) do zaktualizowanej struktury roku. */
export function reconcileWithAcademicYear(plan, makeId) {
  const map = specialDayMap(plan.academicYear);
  const series = new Map();
  for (const e of plan.events) {
    if (!series.has(e.seriesId)) series.set(e.seriesId, []);
    series.get(e.seriesId).push(e);
  }

  const removeIds = new Set();
  const additions = [];

  for (const events of series.values()) {
    if (events.length < 2 || !events[0].subjectId) continue;
    events.sort((a, b) => a.date.localeCompare(b.date));

    const regular = events.filter((e) => !map.has(e.date) || map.get(e.date)?.type === 'rector');
    if (!regular.length) continue;

    const counts = {};
    for (const e of regular) {
      const key = getDayOfWeekKey(e.date);
      counts[key] = (counts[key] || 0) + 1;
    }
    const seriesDay = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const sameDay = regular.filter((e) => getDayOfWeekKey(e.date) === seriesDay);
    const anchor = sameDay[0].date;
    const everyWeeks = sameDay.length > 1 && sameDay.every((e) => weeksBetween(anchor, e.date) % 2 === 0) ? 2 : 1;

    for (const e of events) {
      if (map.has(e.date) && effectiveDayKey(e.date, null, map) !== seriesDay) removeIds.add(e.id);
    }

    const first = events[0].date;
    const last = events[events.length - 1].date;
    const taken = new Set(events.map((e) => e.date));
    for (const [date, sd] of map) {
      if (sd.type !== 'swap' || sd.targetDay !== seriesDay) continue;
      if (date < first || date > last || taken.has(date) || weeksBetween(anchor, date) % everyWeeks !== 0) continue;

      const template = sameDay.reduce((best, e) =>
        Math.abs(Date.parse(e.date) - Date.parse(date)) < Math.abs(Date.parse(best.date) - Date.parse(date)) ? e : best,
      );
      additions.push({ ...template, id: makeId(), date });
    }
  }

  return {
    events: [...plan.events.filter((e) => !removeIds.has(e.id)), ...additions],
    removed: removeIds.size,
    added: additions.length,
  };
}

// --- Walidacja ----------------------------------------------------------------

const isText = (value, maxLength) => typeof value === 'string' && value.length <= maxLength;
const isNonEmptyText = (value, maxLength) => isText(value, maxLength) && value.trim() !== '';
const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isTime = (value) => typeof value === 'string' && TIME_PATTERN.test(value);
const isColor = (value) => typeof value === 'string' && COLOR_PATTERN.test(value);

function validateUniqueCollection(items, validator, errorMessage, ...args) {
  const ids = new Set();
  for (const item of items) {
    if (!validator(item, ids, ...args)) throw Error(errorMessage);
    ids.add(item.id);
  }
  return ids;
}

const isValidSubject = (s, knownIds) =>
  !!s && isId(s.id) && !knownIds.has(s.id) && isNonEmptyText(s.name, LIMITS.subjectName) &&
  (s.color === undefined || isColor(s.color)) && (s.details === undefined || isText(s.details, LIMITS.subjectDetails));

function isValidEvent(e, knownIds, subjectIds) {
  if (!e || !isId(e.id) || knownIds.has(e.id) || !isId(e.seriesId)) return false;
  const hasSubject = subjectIds.has(e.subjectId);
  const isCustom = (e.subjectId === null || e.subjectId === '') && isNonEmptyText(e.customTitle, LIMITS.subjectName);
  if (!hasSubject && !isCustom) return false;
  return (
    (e.customTitle === undefined || isText(e.customTitle, LIMITS.subjectName)) &&
    (e.customColor === undefined || isColor(e.customColor)) &&
    isNonEmptyText(e.type, LIMITS.type) && validDate(e.date) &&
    isTime(e.start) && isTime(e.end) && e.end > e.start &&
    isText(e.room, LIMITS.room) && isText(e.teacher, LIMITS.teacher) && isText(e.notes, LIMITS.notes) &&
    (e.remote === undefined || typeof e.remote === 'boolean')
  );
}

function isValidSpecialDay(sd, knownDates) {
  if (!sd || !validDate(sd.date) || knownDates.has(sd.date)) return false;
  if (!['holiday', 'swap', 'rector', 'session'].includes(sd.type) || !isText(sd.label, LIMITS.dayLabel)) return false;
  if (sd.type === 'swap' && (!sd.targetDay || !DAY_OF_WEEK_PATTERN.test(sd.targetDay))) return false;
  if (sd.type === 'rector') {
    const hasStart = sd.start !== undefined && sd.start !== '';
    const hasEnd = sd.end !== undefined && sd.end !== '';
    if (hasStart !== hasEnd || (hasStart && (!isTime(sd.start) || !isTime(sd.end) || sd.end <= sd.start))) return false;
  }
  return true;
}

/** Rzuca błąd, jeśli plan ma nieprawidłową strukturę. Zwraca ten sam obiekt. */
export function validatePlan(plan) {
  if (
    !plan || plan.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(plan.subjects) || !Array.isArray(plan.events) ||
    plan.subjects.length > LIMITS.subjects || plan.events.length > LIMITS.events
  ) {
    throw Error(`Nieprawidłowy format planu (schemaVersion: ${SCHEMA_VERSION}).`);
  }

  if (plan.academicYear !== undefined) {
    if (typeof plan.academicYear !== 'object' || plan.academicYear === null || !Array.isArray(plan.academicYear.specialDays)) {
      throw Error('Nieprawidłowy format struktury roku akademickiego.');
    }
    if (plan.academicYear.specialDays.length > LIMITS.specialDays) {
      throw Error(`Zbyt wiele dni specjalnych w strukturze roku (maks. ${LIMITS.specialDays}).`);
    }
    const specialDates = new Set();
    for (const sd of plan.academicYear.specialDays) {
      if (!isValidSpecialDay(sd, specialDates)) throw Error('Nieprawidłowy wpis dnia specjalnego w strukturze roku.');
      specialDates.add(sd.date);
    }
  } else {
    plan.academicYear = { specialDays: [] };
  }

  const subjectIds = validateUniqueCollection(plan.subjects, isValidSubject, 'Nieprawidłowy przedmiot.');
  validateUniqueCollection(plan.events, isValidEvent, 'Nieprawidłowy termin zajęć lub brak przedmiotu.', subjectIds);
  return plan;
}

const isValidKanbanColumn = (col, knownColIds) =>
  !!col && isId(col.id) && !knownColIds.has(col.id) && isNonEmptyText(col.title, LIMITS.kanbanColumnTitle);

const isValidChecklistItem = (item, knownItemIds) =>
  !!item && isId(item.id) && !knownItemIds.has(item.id) &&
  isNonEmptyText(item.text, LIMITS.kanbanChecklistText) && typeof item.done === 'boolean';

function isValidKanbanCard(card, knownCardIds, columnIds) {
  if (
    !card || !isId(card.id) || knownCardIds.has(card.id) || !columnIds.has(card.columnId) ||
    !isNonEmptyText(card.title, LIMITS.kanbanCardTitle) ||
    (card.description !== undefined && !isText(card.description, LIMITS.kanbanCardDesc)) ||
    (card.subjectName !== undefined && !isText(card.subjectName, LIMITS.subjectName)) ||
    (card.category !== undefined && !isText(card.category, LIMITS.type)) ||
    !KANBAN_PRIORITIES.has(card.priority) ||
    (card.dueDate !== undefined && card.dueDate !== '' && !validDate(card.dueDate)) ||
    typeof card.order !== 'number' || !Number.isFinite(card.order)
  ) {
    return false;
  }
  if (card.checklist !== undefined) {
    if (!Array.isArray(card.checklist) || card.checklist.length > LIMITS.kanbanChecklistItems) return false;
    const itemIds = new Set();
    if (!card.checklist.every((item) => isValidChecklistItem(item, itemIds) && itemIds.add(item.id))) return false;
  }
  return true;
}

/** Rzuca błąd, jeśli tablica Kanban ma nieprawidłową strukturę. Zwraca ten sam obiekt. */
export function validateKanban(kanban) {
  if (
    !kanban || kanban.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(kanban.columns) || !Array.isArray(kanban.cards) ||
    kanban.columns.length < 1 || kanban.columns.length > LIMITS.kanbanColumns || kanban.cards.length > LIMITS.kanbanCards
  ) {
    throw Error(`Nieprawidłowy format tablicy Kanban (schemaVersion: ${SCHEMA_VERSION}).`);
  }

  const columnIds = validateUniqueCollection(kanban.columns, isValidKanbanColumn, 'Nieprawidłowa kolumna w tablicy Kanban.');
  validateUniqueCollection(kanban.cards, isValidKanbanCard, 'Nieprawidłowa karta zadania w tablicy Kanban.', columnIds);
  return kanban;
}
