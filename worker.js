// Cloudflare Worker: serwuje API /api/plan, a resztę oddaje do statycznych plików z ./public.
// Cały plan jest przechowywany jako jeden obiekt `plan.json` w prywatnym buckecie R2.
//
// Wymagane powiązania (patrz wrangler.jsonc):
//   env.ASSETS     – statyczne pliki frontendu
//   env.PLANS      – bucket R2
//   env.PLAN_TOKEN – sekret (min. 32 znaki), ustawiany przez `wrangler secret put PLAN_TOKEN`

import {
  emptyPlan,
  validatePlan,
  resolvePlanKey,
  emptyKanban,
  validateKanban,
  resolveKanbanKey,
} from './public/model.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MIN_TOKEN_LENGTH = 32;
const ETAG_PATTERN = /^"[a-f0-9]{32}"$/;

// --- Pomocnicze ---------------------------------------------------------------

function reply(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

const error = (message, status, extraHeaders) => reply({ error: message }, status, extraHeaders);

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** Porównuje nagłówek Authorization z sekretem w stałym czasie (porównanie skrótów SHA-256). */
async function isAuthorized(request, token) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) return false;

  const header = request.headers.get('Authorization') || '';
  if (header.length > 512) return false;

  const actual = await sha256(header);
  const expected = await sha256('Bearer ' + token);

  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

/** Czyta treść żądania, przerywając po przekroczeniu limitu. Zwraca null, gdy za duża. */
async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// --- Obsługa metod ------------------------------------------------------------

async function getDocument(env, objectKey, emptyFactory, payloadProp, label) {
  const object = await env.PLANS.get(objectKey);
  if (!object) return reply({ [payloadProp]: emptyFactory(), etag: null });

  let parsed;
  try {
    parsed = await object.json();
  } catch {
    return error(`${label} zapisany w R2 jest uszkodzony.`, 500);
  }
  return reply({ [payloadProp]: parsed, etag: object.etag });
}

async function putDocument(request, env, objectKey, validator, label) {
  // Klient musi podać wersję: If-Match "<etag>" (aktualizacja) albo If-None-Match * (pierwszy zapis).
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  const isUpdate = ifMatch && ETAG_PATTERN.test(ifMatch) && !ifNoneMatch;
  const isCreate = !ifMatch && ifNoneMatch === '*';
  if (!isUpdate && !isCreate) return error(`Wymagana wersja (${label}).`, 428);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.startsWith('application/json')) return error('Wymagany JSON.', 415);

  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) {
    return error(`${label} jest zbyt duży (maks. 2 MB).`, 413);
  }
  if (!request.body) return error('Brak danych.', 400);

  const text = await readBodyWithLimit(request, MAX_BYTES);
  if (text === null) return error(`${label} jest zbyt duży (maks. 2 MB).`, 413);

  let validated;
  try {
    validated = validator(JSON.parse(text));
  } catch (e) {
    return error(e instanceof SyntaxError ? 'Nieprawidłowy JSON.' : e.message, 400);
  }

  // R2 sprawdza warunek atomowo — nie ma wyścigu między odczytem a zapisem.
  const onlyIf = new Headers(isUpdate ? { 'If-Match': ifMatch } : { 'If-None-Match': '*' });
  const saved = await env.PLANS.put(objectKey, JSON.stringify(validated), {
    onlyIf,
    httpMetadata: { contentType: 'application/json' },
  });

  if (!saved) {
    return error(
      `Konflikt: w chmurze jest nowsza wersja (${label}). Wyeksportuj lokalną kopię, a następnie pobierz aktualne dane.`,
      409,
    );
  }
  return reply({ etag: saved.etag });
}

// --- Punkt wejścia ------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Wszystko poza /api/* to statyczny frontend.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const isPlanRoute = url.pathname === '/api/plan';
    const isKanbanRoute = url.pathname === '/api/kanban';
    if (!isPlanRoute && !isKanbanRoute) return error('Nie znaleziono.', 404);

    if (!env.PLAN_TOKEN || env.PLAN_TOKEN.length < MIN_TOKEN_LENGTH) {
      return error('Skonfiguruj sekret PLAN_TOKEN (min. 32 znaki).', 503);
    }
    if (!(await isAuthorized(request, env.PLAN_TOKEN))) {
      return error('Nieprawidłowy klucz dostępu.', 401);
    }

    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return error('Niedozwolone źródło żądania.', 403);

    const rawId = url.searchParams.get('id');
    let objectKey;
    try {
      objectKey = isKanbanRoute ? resolveKanbanKey(rawId) : resolvePlanKey(rawId);
    } catch (e) {
      return error(e.message, 400);
    }

    try {
      if (!env.PLANS) {
        console.error('Błąd: Brak powiązania R2 env.PLANS w konfiguracji Workera.');
        return error('Brak powiązania magazynu R2 (PLANS) w konfiguracji Workera.', 503);
      }
      if (isKanbanRoute) {
        if (request.method === 'GET') {
          return await getDocument(env, objectKey, emptyKanban, 'kanban', 'Plik tablicy Kanban');
        }
        if (request.method === 'PUT') {
          return await putDocument(request, env, objectKey, validateKanban, 'Tablica Kanban');
        }
      } else {
        if (request.method === 'GET') {
          return await getDocument(env, objectKey, emptyPlan, 'plan', 'Plan');
        }
        if (request.method === 'PUT') {
          return await putDocument(request, env, objectKey, validatePlan, 'Plan');
        }
      }
      return error('Dozwolone GET i PUT.', 405, { Allow: 'GET, PUT' });
    } catch (err) {
      console.error('Błąd operacji R2:', err);
      return error(`Nie udało się połączyć z magazynem R2 (${err.message || 'błąd R2'}). Spróbuj ponownie.`, 503);
    }
  },
};
