interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * OKX v5 public MCP.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'OKX v5 public');
}

const BASE = 'https://www.okx.com/api/v5';
const UA = 'pipeworx-mcp-okx/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'instruments',
    description: 'OKX crypto exchange — list instruments by type: \'SPOT\', \'MARGIN\', \'SWAP\', \'FUTURES\', or \'OPTION\'. Returns instrument IDs, tick sizes, lot sizes, and trading rules for each.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instFamily: { type: 'string' }, instId: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'ticker', description: 'OKX crypto exchange — single instrument ticker (e.g. "BTC-USDT", "BTC-USD-SWAP"). Returns bid/ask, last, 24h vol/change. Use for current pricing of an OKX-listed instrument.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  {
    name: 'tickers',
    description: 'OKX crypto exchange — bulk tickers by instrument type ("SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION"). Use to enumerate all spot or all perp instruments. NOT a general stock-ticker search — use polygon-io/tickers for that.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instFamily: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'order_book', description: 'OKX crypto exchange order book (bids + asks) for a spot/perp/futures instrument. Use for live depth-of-book on OKX-listed instruments.', inputSchema: { type: 'object', properties: { instId: { type: 'string' }, sz: { type: 'number' } }, required: ['instId'] } },
  {
    name: 'candles',
    description: 'OKX crypto exchange OHLC candles for a spot/perp/futures instrument. Bars 1m through 1M. Use for charting and backtesting OKX instruments.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, bar: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] },
  },
  { name: 'trades', description: 'OKX crypto exchange recent trade tape for an instrument. Returns price, size, side, timestamp. Use for tick-level execution analysis on OKX.', inputSchema: { type: 'object', properties: { instId: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] } },
  { name: 'market_24hr', description: 'OKX crypto exchange 24-hour rolling stats for an instrument: open, high, low, last, volume, vol-ccy. Use for daily summary on OKX.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  { name: 'index_tickers', description: 'OKX crypto exchange index tickers — current index price and 24h change for OKX index instruments. Filter by quote currency (e.g. \'USD\') or specific instId.', inputSchema: { type: 'object', properties: { quoteCcy: { type: 'string' }, instId: { type: 'string' } } } },
  { name: 'funding_rate', description: 'OKX crypto exchange current perpetual swap funding rate for a SWAP instrument (e.g. \'BTC-USDT-SWAP\'): funding rate, next settlement time, and method.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  {
    name: 'funding_rate_history',
    description: 'OKX crypto exchange historical perpetual swap funding rates for a SWAP instrument (e.g. \'BTC-USDT-SWAP\'). Optional before/after (ms epoch) cursors and limit. Use for funding cost analysis.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] },
  },
  {
    name: 'mark_price',
    description: 'OKX crypto exchange mark price for derivatives: pass instType (e.g. \'SWAP\') and optionally uly or instId. Returns the mark price used for unrealised P&L and liquidation calculations.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instId: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'time', description: 'OKX exchange server time in Unix milliseconds. Use to synchronise request timestamps or verify API connectivity.', inputSchema: { type: 'object', properties: {} } },
  { name: 'status', description: 'OKX exchange system status — current operational state and any scheduled or ongoing maintenance windows affecting trading.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'perp_metrics',
    description: 'Crypto perpetual futures snapshot in one call: funding rate, open interest, taker buy/sell volume (CVD) and long/short account ratio for a perpetual swap. Accepts exchange-style symbols such as \'MASKUSDT\', \'MASK\' or \'MASK-USDT-SWAP\'. Figures come from the OKX venue and the response states that venue, so a symbol quoted on Binance or Bybit is answered with OKX\'s own contract for that coin, labelled as such.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string', description: 'Perpetual symbol — \'MASKUSDT\', \'MASK\', \'MASK-USDT\' and \'MASK-USDT-SWAP\' all resolve to the same OKX contract.' }, period: { type: 'string', description: 'Bucket size for taker flow and long/short ratio: 5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H, 1D. Default 5m.' }, buckets: { type: 'number', description: 'How many recent buckets of taker flow to sum for CVD. Default 24, max 100.' } }, required: ['instId'] },
  },
  {
    name: 'open_interest',
    description: 'Open interest for a crypto perpetual swap or dated futures contract on the OKX venue — contracts outstanding, coin-denominated size and USD notional, with timestamp. Accepts \'MASKUSDT\', \'MASK\' or \'MASK-USDT-SWAP\'. Use to size how much leverage is riding on a perp.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, instType: { type: 'string', description: 'SWAP (default), FUTURES or OPTION.' } }, required: ['instId'] },
  },
  {
    name: 'taker_volume',
    description: 'Taker buy versus taker sell volume for a crypto perpetual contract on the OKX venue, bucketed by period. Returns the per-bucket series, the buy/sell ratio and cumulative volume delta (CVD) across the window — the aggressor-flow input for order-flow and CVD analysis.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, period: { type: 'string', description: '5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H or 1D. Default 5m.' }, buckets: { type: 'number', description: 'Recent buckets to return and sum. Default 24, max 100.' }, unit: { type: 'string', description: '\'0\' for contracts (default), \'1\' for coin.' } }, required: ['instId'] },
  },
  {
    name: 'long_short_ratio',
    description: 'Long/short account ratio for a crypto perpetual contract on the OKX venue — the ratio of accounts holding longs to accounts holding shorts, bucketed by period. A value above 1 means more accounts sit long. Use for positioning and crowd-sentiment reads on a perp.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, period: { type: 'string', description: '5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H or 1D. Default 5m.' }, buckets: { type: 'number', description: 'Recent buckets to return. Default 24, max 100.' } }, required: ['instId'] },
  },
];

/** Quote currencies we peel off a venue-style symbol like "MASKUSDT". Longest first. */
const QUOTE_CCYS = ['USDT', 'USDC', 'USD'];

/**
 * Resolve a perpetual symbol written in any common house style to an OKX instId.
 * "MASKUSDT" (Binance style), "MASK", "MASK/USDT", "MASK-USDT" and "MASK-USDT-SWAP"
 * all land on MASK-USDT-SWAP.
 */
function resolvePerp(raw: string): { instId: string; ccy: string; requested: string; foreignStyle: boolean } {
  const requested = raw.trim();
  const parts = requested.toUpperCase().replace(/[/_\s]+/g, '-').split('-').filter(Boolean);
  if (parts.length >= 3) return { instId: parts.join('-'), ccy: parts[0], requested, foreignStyle: false };
  if (parts.length === 2) return { instId: `${parts[0]}-${parts[1]}-SWAP`, ccy: parts[0], requested, foreignStyle: false };
  const one = parts[0] ?? '';
  for (const q of QUOTE_CCYS) {
    if (one.length > q.length && one.endsWith(q)) {
      const base = one.slice(0, -q.length);
      return { instId: `${base}-${q}-SWAP`, ccy: base, requested, foreignStyle: true };
    }
  }
  return { instId: `${one}-USDT-SWAP`, ccy: one, requested, foreignStyle: false };
}

/** The venue sentence that rides along with every derivatives figure we return. */
function venueNote(r: ReturnType<typeof resolvePerp>): string {
  return r.foreignStyle
    ? `"${r.requested}" is how this perpetual is quoted on Binance-style venues. Every figure below is measured on OKX's own ${r.instId} contract and will differ from the same coin's numbers on another venue. Binance's own perpetual endpoints refuse requests from our infrastructure, and a Binance-specific taker buy/sell breakdown has no public source we can reach.`
    : `Every figure below is measured on OKX's own ${r.instId} contract.`;
}

const iso = (ms: string | number) => new Date(Number(ms)).toISOString();
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

/** Trim an OKX rubik series (newest-first) to the most recent n buckets, oldest-first. */
function recent<T>(rows: T[], n: number): T[] {
  return rows.slice(0, Math.max(1, Math.min(100, Math.floor(n) || 24))).reverse();
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const get = async (path: string, params?: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v));
    const url = `${BASE}${path}${[...p].length ? `?${p}` : ''}`;
    const res = await pwFetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) throw await httpError(res, 'OKX');
    return res.json();
  };
  // OKX answers an unknown instrument with HTTP 200 and code "51001", so every
  // derivatives call has to read the envelope rather than trust the status line.
  const getRows = async (path: string, params?: Record<string, unknown>): Promise<{ rows: unknown[]; code: string; msg: string }> => {
    const body = (await get(path, params)) as { code?: string; msg?: string; data?: unknown[] };
    return { rows: Array.isArray(body?.data) ? body.data : [], code: String(body?.code ?? ''), msg: String(body?.msg ?? '') };
  };
  const unknownInstrument = (r: ReturnType<typeof resolvePerp>, msg: string) => ({
    found: false,
    reason: 'instrument_not_found',
    venue: 'OKX',
    requested: r.requested,
    resolved_instId: r.instId,
    upstream_message: msg,
    hint: `OKX does not list a contract called ${r.instId}. Enumerate the venue's perpetuals with okx tickers({instType:"SWAP"}) and pass an instId from that list.`,
  });
  const reqStr = (k: string, ex: string) => {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${k}" is missing. Pass a string like ${ex}.`);
    return v;
  };
  /**
   * OKX returns taker volume as [ts, sellVol, buyVol] — verified 2026-08-22 by
   * bucketing the live /market/trades tape for MASK-USDT-SWAP and matching it
   * against this endpoint exactly. Reading the columns the other way round
   * inverts the sign of CVD.
   */
  const takerFlow = async (r: ReturnType<typeof resolvePerp>, period: string, buckets: number, unit?: string) => {
    const { rows, msg } = await getRows('/rubik/stat/taker-volume-contract', { instId: r.instId, period, unit });
    if (!rows.length) return unknownInstrument(r, msg);
    const series = recent(rows as string[][], buckets).map(([ts, sell, buy]) => ({
      ts: iso(ts),
      taker_buy: Number(buy),
      taker_sell: Number(sell),
      delta: Number(buy) - Number(sell),
    }));
    const buy = series.reduce((a, b) => a + b.taker_buy, 0);
    const sell = series.reduce((a, b) => a + b.taker_sell, 0);
    return {
      found: true,
      venue: 'OKX',
      requested: r.requested,
      instId: r.instId,
      venue_note: venueNote(r),
      period,
      unit: unit === '1' ? 'coin' : 'contracts',
      buckets: series.length,
      window_start: series[0]?.ts ?? null,
      window_end: series[series.length - 1]?.ts ?? null,
      taker_buy_volume: buy,
      taker_sell_volume: sell,
      taker_buy_sell_ratio: sell > 0 ? Number((buy / sell).toFixed(4)) : null,
      cvd: Number((buy - sell).toFixed(4)),
      latest_bucket: series[series.length - 1] ?? null,
      series,
    };
  };
  const longShort = async (r: ReturnType<typeof resolvePerp>, period: string, buckets: number) => {
    const { rows, msg } = await getRows('/rubik/stat/contracts/long-short-account-ratio-contract', { instId: r.instId, period });
    if (!rows.length) return unknownInstrument(r, msg);
    const series = recent(rows as string[][], buckets).map(([ts, ratio]) => ({ ts: iso(ts), ratio: Number(Number(ratio).toFixed(4)) }));
    const latest = series[series.length - 1] ?? null;
    return {
      found: true,
      venue: 'OKX',
      requested: r.requested,
      instId: r.instId,
      venue_note: venueNote(r),
      period,
      latest_ratio: latest?.ratio ?? null,
      latest_ts: latest?.ts ?? null,
      reading: latest ? (latest.ratio > 1 ? 'more accounts long than short' : 'more accounts short than long') : null,
      series,
    };
  };
  switch (name) {
    case 'instruments':
      return get('/public/instruments', { instType: reqStr('instType', '"SPOT"'), uly: args.uly, instFamily: args.instFamily, instId: args.instId });
    case 'ticker':
      return get('/market/ticker', { instId: reqStr('instId', '"BTC-USDT"') });
    case 'tickers':
      return get('/market/tickers', { instType: reqStr('instType', '"SPOT"'), uly: args.uly, instFamily: args.instFamily });
    case 'order_book':
      return get('/market/books', { instId: reqStr('instId', '"BTC-USDT"'), sz: args.sz });
    case 'candles':
      return get('/market/candles', { instId: reqStr('instId', '"BTC-USDT"'), bar: args.bar, after: args.after, before: args.before, limit: args.limit });
    case 'trades':
      return get('/market/trades', { instId: reqStr('instId', '"BTC-USDT"'), limit: args.limit });
    case 'market_24hr':
      return get('/market/index-tickers', { instId: reqStr('instId', '"BTC-USDT"') });
    case 'index_tickers':
      return get('/market/index-tickers', { quoteCcy: args.quoteCcy, instId: args.instId });
    case 'funding_rate':
      return get('/public/funding-rate', { instId: reqStr('instId', '"BTC-USDT-SWAP"') });
    case 'funding_rate_history':
      return get('/public/funding-rate-history', { instId: reqStr('instId', '"BTC-USDT-SWAP"'), before: args.before, after: args.after, limit: args.limit });
    case 'mark_price':
      return get('/public/mark-price', { instType: reqStr('instType', '"SWAP"'), uly: args.uly, instId: args.instId });
    case 'time':
      return get('/public/time');
    case 'status':
      return get('/system/status');
    case 'open_interest': {
      const r = resolvePerp(reqStr('instId', '"MASK-USDT-SWAP"'));
      const { rows, msg } = await getRows('/public/open-interest', { instType: (args.instType as string) || 'SWAP', instId: r.instId });
      const row = rows[0] as Record<string, string> | undefined;
      if (!row) return unknownInstrument(r, msg);
      return {
        found: true,
        venue: 'OKX',
        requested: r.requested,
        instId: row.instId,
        venue_note: venueNote(r),
        open_interest_contracts: num(row.oi),
        open_interest_coin: num(row.oiCcy),
        open_interest_usd: num(row.oiUsd),
        as_of: iso(row.ts),
      };
    }
    case 'taker_volume': {
      const r = resolvePerp(reqStr('instId', '"MASK-USDT-SWAP"'));
      return takerFlow(r, (args.period as string) || '5m', (args.buckets as number) ?? 24, args.unit as string | undefined);
    }
    case 'long_short_ratio': {
      const r = resolvePerp(reqStr('instId', '"MASK-USDT-SWAP"'));
      return longShort(r, (args.period as string) || '5m', (args.buckets as number) ?? 24);
    }
    case 'perp_metrics': {
      const r = resolvePerp(reqStr('instId', '"MASKUSDT"'));
      const period = (args.period as string) || '5m';
      const buckets = (args.buckets as number) ?? 24;
      const settle = async <T>(p: Promise<T>) =>
        p.catch((e: unknown) => ({ found: false, reason: 'upstream_error', detail: e instanceof Error ? e.message : String(e) }));
      const [funding, oi, flow, ls] = await Promise.all([
        settle(
          getRows('/public/funding-rate', { instId: r.instId }).then(({ rows, msg }) => {
            const row = rows[0] as Record<string, string> | undefined;
            if (!row) return unknownInstrument(r, msg);
            return {
              found: true,
              funding_rate: num(row.fundingRate),
              funding_rate_pct: row.fundingRate ? Number((Number(row.fundingRate) * 100).toFixed(6)) : null,
              next_funding_rate: num(row.nextFundingRate),
              funding_time: row.fundingTime ? iso(row.fundingTime) : null,
              next_funding_time: row.nextFundingTime ? iso(row.nextFundingTime) : null,
              premium: num(row.premium),
              method: row.method ?? null,
            };
          }),
        ),
        settle(
          getRows('/public/open-interest', { instType: 'SWAP', instId: r.instId }).then(({ rows, msg }) => {
            const row = rows[0] as Record<string, string> | undefined;
            if (!row) return unknownInstrument(r, msg);
            return { found: true, contracts: num(row.oi), coin: num(row.oiCcy), usd: num(row.oiUsd), as_of: iso(row.ts) };
          }),
        ),
        settle(takerFlow(r, period, buckets, undefined)),
        settle(longShort(r, period, buckets)),
      ]);
      // takerFlow/longShort each carry the venue header for standalone use; inside
      // the composite it is stated once at the top instead of three times.
      const inner = (v: unknown) => {
        if (!v || typeof v !== 'object') return v;
        const { venue: _v, requested: _r, instId: _i, venue_note: _n, ...rest } = v as Record<string, unknown>;
        return rest;
      };
      const hit = (v: unknown) => !!(v && typeof v === 'object' && (v as { found?: boolean }).found);
      return {
        found: hit(funding) || hit(oi) || hit(flow) || hit(ls),
        venue: 'OKX',
        requested: r.requested,
        instId: r.instId,
        venue_note: venueNote(r),
        funding_rate: inner(funding),
        open_interest: inner(oi),
        taker_flow: inner(flow),
        long_short_account_ratio: inner(ls),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
