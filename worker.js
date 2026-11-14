// Cloudflare Worker: serwuje API /api/plan i /api/kanban, a resztę oddaje do statycznych plików ./public.
// Wymagane powiązania (wrangler.jsonc): env.ASSETS, env.PLANS (R2), env.PLAN_TOKEN (sekret >= 32 znaki).

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

const ROUTES = {
  '/api/plan': {
    resolveKey: resolvePlanKey,
    empty: emptyPlan,
    validate: validatePlan,
    prop: 'plan',
    getLabel: 'Plan',
    putLabel: 'Plan',
  },
  '/api/kanban': {
    resolveKey: resolveKanbanKey,
    empty: emptyKanban,
    validate: validateKanban,
    prop: 'kanban',
    getLabel: 'Plik tablicy Kanban',
    putLabel: 'Tablica Kanban',
  },
};

const reply = (body, status = 200, extraHeaders = {}) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });

const error = (message, status, extraHeaders) => reply({ error: message }, status, extraHeaders);

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Porównuje nagłówek Authorization z sekretem w stałym czasie (porównanie skrótów SHA-256). */
async function isAuthorized(request, token) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get('Authorization') || '';
  if (header.length > 512) return false;

  const [actual, expected] = await Promise.all([sha256(header), sha256('Bearer ' + token)]);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Czyta treść żądania, przerywając po przekroczeniu limitu. Zwraca null, gdy za duża. */
async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if ((size += value.byteLength) > maxBytes) {
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

async function getDocument(env, objectKey, { empty, prop, getLabel }) {
  const object = await env.PLANS.get(objectKey);
  if (!object) return reply({ [prop]: empty(), etag: null });
  try {
    return reply({ [prop]: await object.json(), etag: object.etag });
  } catch {
    return error(`${getLabel} zapisany w R2 jest uszkodzony.`, 500);
  }
}

async function putDocument(request, env, objectKey, { validate, putLabel }) {
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  const isUpdate = ifMatch && ETAG_PATTERN.test(ifMatch) && !ifNoneMatch;
  const isCreate = !ifMatch && ifNoneMatch === '*';
  if (!isUpdate && !isCreate) return error(`Wymagana wersja (${putLabel}).`, 428);

  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return error('Wymagany JSON.', 415);
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) {
    return error(`${putLabel} jest zbyt duży (maks. 2 MB).`, 413);
  }
  if (!request.body) return error('Brak danych.', 400);

  const text = await readBodyWithLimit(request, MAX_BYTES);
  if (text === null) return error(`${putLabel} jest zbyt duży (maks. 2 MB).`, 413);

  let validated;
  try {
    validated = validate(JSON.parse(text));
  } catch (e) {
    return error(e instanceof SyntaxError ? 'Nieprawidłowy JSON.' : e.message, 400);
  }

  // R2 sprawdza warunek atomowo — brak wyścigu między odczytem a zapisem.
  const saved = await env.PLANS.put(objectKey, JSON.stringify(validated), {
    onlyIf: new Headers(isUpdate ? { 'If-Match': ifMatch } : { 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json' },
  });
  if (!saved) {
    return error(
      `Konflikt: w chmurze jest nowsza wersja (${putLabel}). Wyeksportuj lokalną kopię, a następnie pobierz aktualne dane.`,
      409,
    );
  }
  return reply({ etag: saved.etag });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const route = ROUTES[url.pathname];
    if (!route) return error('Nie znaleziono.', 404);
    if (!env.PLAN_TOKEN || env.PLAN_TOKEN.length < MIN_TOKEN_LENGTH) {
      return error('Skonfiguruj sekret PLAN_TOKEN (min. 32 znaki).', 503);
    }
    if (!(await isAuthorized(request, env.PLAN_TOKEN))) return error('Nieprawidłowy klucz dostępu.', 401);

    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return error('Niedozwolone źródło żądania.', 403);

    let objectKey;
    try {
      objectKey = route.resolveKey(url.searchParams.get('id'));
    } catch (e) {
      return error(e.message, 400);
    }

    try {
      if (!env.PLANS) {
        console.error('Błąd: Brak powiązania R2 env.PLANS w konfiguracji Workera.');
        return error('Brak powiązania magazynu R2 (PLANS) w konfiguracji Workera.', 503);
      }
      if (request.method === 'GET') return await getDocument(env, objectKey, route);
      if (request.method === 'PUT') return await putDocument(request, env, objectKey, route);
      return error('Dozwolone GET i PUT.', 405, { Allow: 'GET, PUT' });
    } catch (err) {
      console.error('Błąd operacji R2:', err);
      return error(`Nie udało się połączyć z magazynem R2 (${err.message || 'błąd R2'}). Spróbuj ponownie.`, 503);
    }
  },
};
