// Diagnostyka: lekki, w pamięci log wywołań ZEWNĘTRZNYCH API (per provider, ring buffer).
import { logEvent } from "./db.ts";

// Cel — wgląd w to, których serwerów używamy, ile było zapytań i czy ostatnie odpowiedzi
// były OK/error (do wychwytywania problemów przy testach). Resetuje się po restarcie serwera.

export type Provider =
  | "claude"
  | "openai"
  | "google"
  | "google_places"
  | "google_cse"
  | "tripadvisor"
  | "serper"
  | "serpapi"
  | "wikimedia"
  | "openverse"
  | "app" // ruch apka ↔ serwer (upload zdjęć + odpowiedzi) — mierzony w middleware
  | "other";

export interface ApiLogEntry {
  ts: number; // epoch ms
  op: string; // krótka nazwa operacji
  ok: boolean;
  ms: number; // czas trwania
  detail?: string; // komunikat błędu / status
}

interface State {
  entries: ApiLogEntry[];
  total: number;
  errors: number;
  // Zużycie tokenów + koszt (dla AI — to ono robi koszt, nie liczba wywołań).
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  // Przesłane dane (bajty): wysłane przez serwer (egress — płatne na Railway) i odebrane (ingress).
  bytesSent: number;
  bytesRecv: number;
}

function getState(provider: Provider): State {
  let s = store.get(provider);
  if (!s) {
    s = { entries: [], total: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, bytesSent: 0, bytesRecv: 0 };
    store.set(provider, s);
  }
  return s;
}

/** Dolicza przesłane bajty (sent = wysłane przez serwer, recv = odebrane) do providera. */
export function recordBytes(provider: Provider, sent: number, recv: number): void {
  const s = getState(provider);
  s.bytesSent += Math.max(0, Math.round(sent));
  s.bytesRecv += Math.max(0, Math.round(recv));
}

/** Rozmiar w bajtach ciała żądania (string/Buffer/typed array) — do liczenia egressu. */
export function bodyBytes(body: unknown): number {
  if (!body) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

const MAX = 40; // ostatnich wpisów na providera
const store = new Map<Provider, State>();

export function record(provider: Provider, op: string, ok: boolean, ms: number, detail?: string): void {
  const s = getState(provider);
  s.total++;
  if (!ok) s.errors++;
  s.entries.unshift({ ts: Date.now(), op, ok, ms: Math.round(ms), detail: detail?.slice(0, 300) });
  if (s.entries.length > MAX) s.entries.length = MAX;
  // Błędy trafiają też do TRWAŁEGO logu (przeżywają redeploy) — do diagnostyki później.
  if (!ok) logEvent({ type: "error", provider, op, data: { ms: Math.round(ms), detail: detail?.slice(0, 300) ?? null } });
}

/** Dokłada zużycie tokenów + koszt do providera (dla AI). Wołane po policzeniu usage. */
export function recordUsage(provider: Provider, inputTokens: number, outputTokens: number, costUsd: number): void {
  const s = getState(provider);
  s.inputTokens += inputTokens;
  s.outputTokens += outputTokens;
  s.costUsd += costUsd;
}

/** Mierzy + loguje dowolną async operację (np. wywołanie SDK Claude). Re-rzuca błąd. */
export async function track<T>(provider: Provider, op: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    record(provider, op, true, Date.now() - t0);
    return r;
  } catch (e) {
    record(provider, op, false, Date.now() - t0, (e as Error)?.message ?? String(e));
    throw e;
  }
}

function detect(u: string): { provider: Provider; op: string } {
  let host = "";
  let path = "";
  try {
    const url = new URL(u);
    host = url.hostname;
    path = url.pathname;
  } catch {
    /* zostaw puste */
  }
  const op = (path.split("/").filter(Boolean).pop() || "request").slice(0, 40);
  const provider: Provider = host.includes("serper.dev")
    ? "serper"
    : host.includes("serpapi.com")
      ? "serpapi"
      : host.includes("customsearch")
        ? "google_cse"
        : host.includes("googleapis.com")
          ? "google_places"
          : host.includes("tripadvisor")
            ? "tripadvisor"
            : host.includes("wikimedia") || host.includes("wikipedia")
              ? "wikimedia"
              : host.includes("openverse")
                ? "openverse"
                : "other";
  return { provider, op };
}

// Timeout dla zewnętrznych fetchy (Serper/Places/TripAdvisor itd.) — zawieszony upstream
// nie blokuje requestu w nieskończoność. SDK Anthropic/OpenAI mają własne timeouty (nie tędy).
const FETCH_TIMEOUT_MS = 10000;

/** Drop-in zamiennik `fetch` dla wywołań zewnętrznych — sam wykrywa providera z URL i loguje. */
export async function trackedFetch(input: string | URL, init?: RequestInit, op?: string): Promise<Response> {
  const urlStr = typeof input === "string" ? input : input.toString();
  const d = detect(urlStr);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(input, { ...init, signal: init?.signal ?? ctrl.signal });
    let detail: string | undefined;
    if (!res.ok) {
      // Dołóż fragment treści odpowiedzi — pozwala sklasyfikować błąd (quota/klucz/itp.).
      const body = await res.clone().text().catch(() => "");
      detail = `HTTP ${res.status}${body ? " " + body.replace(/\s+/g, " ").slice(0, 180) : ""}`;
    }
    record(d.provider, op ?? d.op, res.ok, Date.now() - t0, detail);
    // Ruch: wysłane = ciało żądania; odebrane = z nagłówka Content-Length (best-effort, gdy jest).
    recordBytes(d.provider, bodyBytes(init?.body), Number(res.headers.get("content-length")) || 0);
    return res;
  } catch (e) {
    const msg = ctrl.signal.aborted ? `timeout ${FETCH_TIMEOUT_MS}ms` : (e as Error)?.message ?? String(e);
    record(d.provider, op ?? d.op, false, Date.now() - t0, msg);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderReport {
  provider: Provider;
  total: number;
  ok: number;
  errors: number;
  lastAt: number | null;
  lastError: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  bytesSent: number;
  bytesRecv: number;
  entries: ApiLogEntry[];
}

/** Pełny zrzut do endpointu /diagnostics. */
export function snapshot(): ProviderReport[] {
  return [...store.entries()]
    .map(([provider, s]) => ({
      provider,
      total: s.total,
      ok: s.total - s.errors,
      errors: s.errors,
      lastAt: s.entries[0]?.ts ?? null,
      lastError: s.entries.find((e) => !e.ok)?.detail ?? null,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      bytesSent: s.bytesSent,
      bytesRecv: s.bytesRecv,
      entries: s.entries,
    }))
    .sort((a, b) => b.total - a.total);
}
