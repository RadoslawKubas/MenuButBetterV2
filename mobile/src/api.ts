// Klient API backendu. Adres bazowy wykrywamy automatycznie z hosta dev-serwera
// Expo (żeby działało na fizycznym telefonie bez ręcznego wpisywania IP).
import Constants from "expo-constants";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Application from "expo-application";
import * as appLog from "./appLog";
import { ZERO_USAGE, type DishPhotoLite, type GeoPoint, type Menu, type ModelId, type PhotoDebug, type RestaurantInfo, type Usage } from "./types";

const API_PORT = 8787;

function resolveApiBase(): string {
  // 1) Ręczne nadpisanie przez zmienną środowiskową (EXPO_PUBLIC_* trafia do appki).
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override) return override.replace(/\/$/, "");

  // 2) Host maszyny dev z konfiguracji Expo (np. "192.168.1.10:8081").
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig?.debuggerHost as string | undefined);
  if (hostUri) {
    const host = hostUri.split(":")[0];
    return `http://${host}:${API_PORT}`;
  }

  // 3) Ostatnia deska ratunku (symulator).
  return `http://localhost:${API_PORT}`;
}

export const API_BASE = resolveApiBase();

// Token aplikacji (gdy backend w chmurze go wymaga). Wstrzykiwany do buildu przez EAS
// jako EXPO_PUBLIC_APP_TOKEN. Pusty lokalnie → nagłówek nie jest wysyłany (LAN bez tokena).
const APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN ?? "";

/** Nagłówki zapytań JSON + (opcjonalnie) token aplikacji. */
// GUID INSTALACJI apki — identyfikuje KONKRETNĄ instalację (do debugowania). Trwa między
// uruchomieniami (AsyncStorage), nie musi przeżyć reinstalacji. Doklejany do KAŻDEGO żądania
// (x-install-id) → serwer taguje nim wszystkie zdarzenia (skan/ai/sample/błąd) → grupowanie w labie.
let INSTALL_ID = "";
function genInstallId(): string {
  return "i_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
/** Wczytuje/tworzy GUID instalacji (raz, na starcie apki) + opróżnia kolejkę błędów offline. */
export async function initInstallId(): Promise<string> {
  if (INSTALL_ID) return INSTALL_ID;
  try {
    const stored = await AsyncStorage.getItem("install-id");
    if (stored) INSTALL_ID = stored;
  } catch { /* ignoruj */ }
  if (!INSTALL_ID) {
    INSTALL_ID = genInstallId();
    try { await AsyncStorage.setItem("install-id", INSTALL_ID); } catch { /* ignoruj */ }
  }
  void flushErrorQueue();
  return INSTALL_ID;
}
export function getInstallId(): string { return INSTALL_ID; }

// DEBUG: wymuszenie świeżego wyniku — serwer omija ODCZYT z cache (generuje od nowa), ale wynik nadal
// ZAPISUJE (cache się odświeża). Stan trzymany w pamięci + AsyncStorage (przeżywa restart apki).
let FORCE_FRESH = false;
export function isForceFresh(): boolean { return FORCE_FRESH; }
export async function initForceFresh(): Promise<void> {
  try { FORCE_FRESH = (await AsyncStorage.getItem("force-fresh")) === "1"; } catch { /* ignoruj */ }
}
export async function setForceFresh(on: boolean): Promise<void> {
  FORCE_FRESH = on;
  try { await AsyncStorage.setItem("force-fresh", on ? "1" : "0"); } catch { /* ignoruj */ }
}

/** Rejestruje instalację na serwerze: urządzenie (model/brand/OS) + wersja apki → zakładka „Instancje". */
export async function registerInstall(): Promise<void> {
  try {
    await initInstallId();
    void fetch(`${API_BASE}/install/register`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        installId: INSTALL_ID,
        deviceModel: Device.modelName ?? undefined,
        brand: Device.brand ?? undefined,
        osName: Device.osName ?? Platform.OS,
        osVersion: Device.osVersion ?? undefined,
        appVersion: APP_VERSION,
      }),
    }).catch(() => {});
  } catch { /* ignoruj — rejestracja nie może wywalić apki */ }
}

function jsonHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  if (INSTALL_ID) h["x-install-id"] = INSTALL_ID;
  if (FORCE_FRESH) h["x-force-fresh"] = "1"; // debug: omiń odczyt z cache (serwer i tak zapisze świeży wynik)
  return h;
}

/** fetch z logowaniem do diagnostyki (czas, ok/błąd) + powiadomieniem o błędzie (toast). */
async function loggedFetch(label: string, input: string, init?: RequestInit): Promise<Response> {
  const t0 = Date.now();
  try {
    const res = await fetch(input, init);
    appLog.logCall({
      ts: Date.now(),
      label,
      ok: res.ok,
      ms: Date.now() - t0,
      detail: res.ok ? undefined : `HTTP ${res.status}`,
    });
    // Błędy serwera (5xx) — diagnostycznie istotne (API nie zwraca poprawnie). 4xx zwykle obsługiwane
    // przez wywołującego, więc tu nie raportujemy, by nie zaśmiecać.
    if (res.status >= 500) reportError(`API ${label}: HTTP ${res.status}`, { label: `api:${label}`, context: { status: res.status, ms: Date.now() - t0 } });
    return res;
  } catch (e) {
    appLog.logCall({ ts: Date.now(), label, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
    reportError((e as Error)?.message ?? String(e), { stack: (e as Error)?.stack, label: `net:${label}` });
    throw e;
  }
}

// Wersja + numer buildu. Build jest remote w EAS (autoIncrement) → NIE ma go w app.json, a
// Constants.nativeBuildVersion bywa puste. expo-application czyta natywny CFBundleVersion/versionCode
// z gotowego buildu w runtime (niezawodne na TestFlight). Fallbacki na wypadek braku.
const APP_VERSION = `${Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "?"} (build ${Application.nativeBuildVersion ?? Constants.nativeBuildVersion ?? "?"})`;
const ERR_QUEUE_KEY = "err-queue";

type ErrPayload = { message: string; stack?: string; label?: string; context?: unknown; appVersion: string; platform: string; at: number };

async function enqueueError(p: ErrPayload): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ERR_QUEUE_KEY);
    const q: ErrPayload[] = raw ? JSON.parse(raw) : [];
    q.push(p);
    while (q.length > 50) q.shift(); // cap — najstarsze wypadają
    await AsyncStorage.setItem(ERR_QUEUE_KEY, JSON.stringify(q));
  } catch { /* ignoruj */ }
}

/** Ponawia wysyłkę zalegających błędów (np. po odzyskaniu netu). Wołane na starcie apki. */
export async function flushErrorQueue(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ERR_QUEUE_KEY);
    if (!raw) return;
    const q: ErrPayload[] = JSON.parse(raw);
    if (!q.length) return;
    const remaining: ErrPayload[] = [];
    for (const p of q) {
      try {
        const res = await fetch(`${API_BASE}/client-error`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(p) });
        if (!res.ok) remaining.push(p);
      } catch { remaining.push(p); }
    }
    await AsyncStorage.setItem(ERR_QUEUE_KEY, JSON.stringify(remaining));
  } catch { /* ignoruj */ }
}

/**
 * Zgłasza błąd na serwer (trwały log → zakładka „Błędy" w labie). Fire‑and‑forget; gdy się NIE uda
 * (brak netu/serwer) → ląduje w kolejce offline i jest ponawiane później. Nie blokuje i nie rzuca.
 */
export function reportError(message: string, opts?: { stack?: string; label?: string; context?: unknown }): void {
  const p: ErrPayload = {
    message: String(message).slice(0, 1000),
    stack: opts?.stack,
    label: opts?.label,
    context: opts?.context,
    appVersion: APP_VERSION,
    platform: Platform.OS,
    at: Date.now(),
  };
  void (async () => {
    try {
      const res = await fetch(`${API_BASE}/client-error`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(p) });
      if (!res.ok) await enqueueError(p);
    } catch {
      await enqueueError(p); // brak netu / serwer niedostępny → spróbuj później
    }
  })();
}

export interface ScanImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface ScanParams {
  images: ScanImage[];
  targetLang: string;
  restaurantHint?: string;
  /** „Miasto, Kraj" z GPS — daje modelowi pewny kontekst gdzie jest lokal. */
  locationHint?: string;
  /** Wstępnie rozpoznana kuchnia (z „szybkiego podglądu") — mocna wskazówka kontekstu. */
  cuisineHint?: string;
  /** Model przebiegu STRUKTURY (vision). */
  model: ModelId;
  /** Model przebiegu WZBOGACANIA (tekst: tłumaczenia/opisy/photo_query). Domyślnie = model. */
  enrichModel?: ModelId;
  /** Tylko STRUKTURA (Faza A): szybkie, kompletne menu z oryginalnymi nazwami; enrich osobno (/enrich). */
  structureOnly?: boolean;
  /** Sekcje z wcześniejszych partii (ciągłość grup między stronami przy menu dzielonym na partie). */
  knownSections?: string[];
}

/** Postęp skanu: wysyłka zdjęć (%) → serwer odebrał → model czyta (czas) → składanie. */
export type ScanPhase =
  | { phase: "uploading"; pct: number }
  | { phase: "received" }
  | { phase: "extracting"; elapsedMs: number; items?: number }
  | { phase: "finalizing" };

/** Pozycja wyłuskana NA ŻYWO ze strumienia (nazwa + photo_query) — do podglądu i prefetchu zdjęć. */
export interface ScanItemStub {
  original: string;
  translated: string;
  photoQuery: string;
  photoQueryLocal: string;
  branded: boolean;
  description: string;
  price: string | null;
  currency: string | null;
}

/**
 * Skan menu z PODGLĄDEM POSTĘPU. Używa XMLHttpRequest (fetch w RN nie daje postępu wysyłki):
 *  • `upload.onprogress` → ile zdjęć już poszło (%),
 *  • strumień NDJSON z serwera (`stream:true`) → kroki „odebrano / model czyta (Ns)".
 * Stary serwer i tak by zadziałał (zignoruje NDJSON), ale my parsujemy linie.
 */
export function scanMenu(
  params: ScanParams,
  onProgress?: (p: ScanPhase) => void,
  onItem?: (item: ScanItemStub) => void,
  onEnrichItem?: (item: ScanItemStub) => void,
  onMeta?: (m: { restaurantName?: string; cuisine?: string }) => void,
): Promise<{ menu: Menu; usage: Usage; cached: boolean; lowQuality: boolean; partialQuality: boolean; enriched: boolean }> {
  const t0 = Date.now();
  const body = JSON.stringify({
    images: params.images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
    targetLang: params.targetLang,
    restaurantHint: params.restaurantHint,
    locationHint: params.locationHint,
    cuisineHint: params.cuisineHint,
    model: params.model,
    enrichModel: params.enrichModel,
    structureOnly: params.structureOnly === true,
    knownSections: params.knownSections,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/scan`);
    Object.entries(jsonHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v as string));
    xhr.timeout = 240000; // duży batch struktury (domyślnie 10 zdjęć) potrafi liczyć ~1.5–2 min — zapas

    // Postęp WYSYŁKI zdjęć (najdłuższe przy wielu/dużych zdjęciach).
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ phase: "uploading", pct: e.loaded / e.total });
    };
    xhr.upload.onload = () => onProgress?.({ phase: "received" });

    // Strumień odpowiedzi: parsujemy KROKI NDJSON w miarę napływu (responseText rośnie).
    let scanned = 0;
    const parseLines = (text: string) => {
      const nl = text.lastIndexOf("\n");
      if (nl < scanned) return;
      const chunk = text.slice(scanned, nl);
      scanned = nl + 1;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.phase === "extracting") onProgress?.({ phase: "extracting", elapsedMs: ev.elapsedMs ?? Date.now() - t0, items: ev.items });
          else if (ev.phase === "received") onProgress?.({ phase: "received" });
          else if (ev.phase === "item")
            onItem?.({
              original: ev.original,
              translated: ev.translated,
              photoQuery: ev.photoQuery,
              photoQueryLocal: ev.photoQueryLocal,
              branded: !!ev.branded,
              description: ev.description ?? "",
              price: ev.price ?? null,
              currency: ev.currency ?? null,
            });
          else if (ev.phase === "enrich-item")
            onEnrichItem?.({
              original: ev.original,
              translated: ev.translated,
              photoQuery: ev.photoQuery,
              photoQueryLocal: ev.photoQueryLocal,
              branded: !!ev.branded,
              description: ev.description ?? "",
              price: ev.price ?? null,
              currency: ev.currency ?? null,
            });
          else if (ev.phase === "meta") onMeta?.({ restaurantName: ev.restaurantName, cuisine: ev.cuisine });
        } catch {
          /* niepełna linia — doczyta się później */
        }
      }
    };
    xhr.onprogress = () => parseLines(xhr.responseText);

    const fail = (msg: string) => {
      appLog.logCall({ ts: Date.now(), label: "scan", ok: false, ms: Date.now() - t0, detail: msg });
      reject(new Error(msg));
    };
    xhr.onerror = () => fail("Błąd sieci podczas skanu.");
    xhr.ontimeout = () => fail("Skan trwał za długo (timeout).");
    xhr.onload = () => {
      appLog.logCall({ ts: Date.now(), label: "scan", ok: xhr.status >= 200 && xhr.status < 300, ms: Date.now() - t0, detail: xhr.status >= 200 && xhr.status < 300 ? undefined : `HTTP ${xhr.status}` });
      onProgress?.({ phase: "finalizing" });
      // Wynik: ostatnia kompletna linia JSON z `menu`/`error`/`done`.
      const text = xhr.responseText || "";
      let result: { menu?: Menu; usage?: Usage; error?: string; cached?: boolean; lowQuality?: boolean; partialQuality?: boolean; enriched?: boolean } | null = null;
      for (const line of text.split("\n")) {
        const tt = line.trim();
        if (!tt) continue;
        try {
          const ev = JSON.parse(tt);
          if (ev.menu || ev.error || ev.done) result = ev;
        } catch {
          /* pomiń niepełne/keepalive */
        }
      }
      if (!result) {
        // Strumień się zaczął (były kroki/pozycje), ale nie doszła finalna linia → połączenie urwane.
        const truncated = text.length > 0;
        return fail(truncated ? "Połączenie przerwane w trakcie skanu — spróbuj ponownie." : `Pusta odpowiedź serwera (HTTP ${xhr.status}).`);
      }
      if (xhr.status < 200 || xhr.status >= 300 || result.error) {
        return fail(result.error ?? `Błąd serwera (HTTP ${xhr.status})`);
      }
      if (!result.menu) return fail("Pusta odpowiedź serwera.");
      resolve({ menu: result.menu, usage: result.usage ?? ZERO_USAGE, cached: !!result.cached, lowQuality: !!result.lowQuality, partialQuality: !!result.partialQuality, enriched: result.enriched !== false });
    };
    xhr.send(body);
  });
}

/**
 * FAZA B — wzbogacenie gotowej STRUKTURY menu (tłumaczenia/opisy/photo_query), tekstowo, BEZ zdjęć.
 * Strumień `enrich-item` po `original` → apka patchuje pozycje W MIEJSCU (bez zmiany kolejności/grup).
 * Zwraca pełne wzbogacone Menu (do finalnego zapisu). Enrich ma cache per pozycja → replay ~darmowy.
 */
export function enrichMenuOnServer(
  structureMenu: Menu,
  params: { targetLang: string; locationHint?: string; cuisineHint?: string; model?: ModelId; enrichModel?: ModelId },
  onProgress?: (p: ScanPhase) => void,
  onEnrichItem?: (item: ScanItemStub) => void,
): Promise<{ menu: Menu; usage: Usage }> {
  const t0 = Date.now();
  const body = JSON.stringify({
    menu: structureMenu,
    targetLang: params.targetLang,
    locationHint: params.locationHint,
    cuisineHint: params.cuisineHint,
    model: params.model,
    enrichModel: params.enrichModel,
    stream: true,
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/enrich`);
    Object.entries(jsonHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v as string));
    xhr.timeout = 240000; // enrich dużego menu (setki pozycji) — zapas
    let scanned = 0;
    const parseLines = (text: string) => {
      const nl = text.lastIndexOf("\n");
      if (nl < scanned) return;
      const chunk = text.slice(scanned, nl);
      scanned = nl + 1;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.phase === "extracting") onProgress?.({ phase: "extracting", elapsedMs: ev.elapsedMs ?? Date.now() - t0, items: 0 });
          else if (ev.phase === "enrich-item")
            onEnrichItem?.({
              original: ev.original,
              translated: ev.translated,
              photoQuery: ev.photoQuery,
              photoQueryLocal: ev.photoQueryLocal,
              branded: !!ev.branded,
              description: ev.description ?? "",
              price: ev.price ?? null,
              currency: ev.currency ?? null,
            });
        } catch {
          /* niepełna linia */
        }
      }
    };
    xhr.onprogress = () => parseLines(xhr.responseText);
    const fail = (msg: string) => {
      appLog.logCall({ ts: Date.now(), label: "enrich", ok: false, ms: Date.now() - t0, detail: msg });
      reject(new Error(msg));
    };
    xhr.onerror = () => fail("Błąd sieci podczas wzbogacania.");
    xhr.ontimeout = () => fail("Wzbogacanie trwało za długo (timeout).");
    xhr.onload = () => {
      appLog.logCall({ ts: Date.now(), label: "enrich", ok: xhr.status >= 200 && xhr.status < 300, ms: Date.now() - t0, detail: xhr.status >= 200 && xhr.status < 300 ? undefined : `HTTP ${xhr.status}` });
      const text = xhr.responseText || "";
      let result: { menu?: Menu; usage?: Usage; error?: string } | null = null;
      for (const line of text.split("\n")) {
        const tt = line.trim();
        if (!tt) continue;
        try {
          const ev = JSON.parse(tt);
          if (ev.menu || ev.error || ev.done) result = ev;
        } catch {
          /* keepalive/niepełne */
        }
      }
      if (!result) return fail("Wzbogacanie przerwane — spróbuj ponownie.");
      if (xhr.status < 200 || xhr.status >= 300 || result.error) return fail(result.error ?? `Błąd serwera (HTTP ${xhr.status})`);
      if (!result.menu) return fail("Pusta odpowiedź serwera.");
      resolve({ menu: result.menu, usage: result.usage ?? ZERO_USAGE });
    };
    xhr.send(body);
  });
}

// ─── ARCHITEKTURA B: streaming upload. Apka wysyła zdjęcia POJEDYNCZO (odporne — retry per zdjęcie,
// pasek postępu), serwer buforuje per sesja i sam tnie na partie modelu w /scan/run. ───

/** Zaczyna sesję skanu (parametry bez zdjęć) → zwraca sessionId. */
export async function scanStart(params: { targetLang: string; restaurantHint?: string; locationHint?: string; cuisineHint?: string; model?: ModelId; enrichModel?: ModelId }): Promise<string> {
  const res = await fetch(`${API_BASE}/scan/start`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`Nie udało się rozpocząć skanu (HTTP ${res.status}).`);
  const json = (await res.json()) as { sessionId?: string };
  if (!json.sessionId) throw new Error("Serwer nie zwrócił sesji skanu.");
  return json.sessionId;
}

/** Wysyła JEDNO zdjęcie do sesji (POJEDYNCZA próba — ponawianiem steruje wywołujący: 1 auto-retry, potem
 *  pyta usera). Idempotentne po `index`. `takenAt` (EXIF) → serwer ułoży strony po dacie zrobienia. */
export function scanUploadPhoto(sessionId: string, index: number, image: { base64: string; mediaType: string; takenAt?: number | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/scan/photo`);
    Object.entries(jsonHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v as string));
    xhr.timeout = 90000;
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error(`Zdjęcie ${index + 1}: HTTP ${xhr.status}`)); };
    xhr.onerror = () => reject(new Error(`Zdjęcie ${index + 1}: błąd sieci`));
    xhr.ontimeout = () => reject(new Error(`Zdjęcie ${index + 1}: timeout`));
    xhr.send(JSON.stringify({ sessionId, index, base64: image.base64, mediaType: image.mediaType, takenAt: image.takenAt ?? undefined }));
  });
}

/** Uruchamia skan sesji — serwer tnie po rozmiarze, streamuje STRUKTURĘ (item/meta) i zwraca menu. */
export function scanRun(
  sessionId: string,
  onProgress?: (p: ScanPhase) => void,
  onItem?: (item: ScanItemStub) => void,
  onMeta?: (m: { restaurantName?: string; cuisine?: string }) => void,
): Promise<{ menu: Menu; usage: Usage; cached: boolean }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/scan/run`);
    Object.entries(jsonHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v as string));
    xhr.timeout = 240000;
    let scanned = 0;
    const parseLines = (text: string) => {
      const nl = text.lastIndexOf("\n");
      if (nl < scanned) return;
      const chunk = text.slice(scanned, nl);
      scanned = nl + 1;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.phase === "extracting") onProgress?.({ phase: "extracting", elapsedMs: ev.elapsedMs ?? Date.now() - t0, items: ev.items });
          else if (ev.phase === "received") onProgress?.({ phase: "received" });
          else if (ev.phase === "item") onItem?.({ original: ev.original, translated: ev.translated, photoQuery: ev.photoQuery, photoQueryLocal: ev.photoQueryLocal, branded: !!ev.branded, description: ev.description ?? "", price: ev.price ?? null, currency: ev.currency ?? null });
          else if (ev.phase === "meta") onMeta?.({ restaurantName: ev.restaurantName, cuisine: ev.cuisine });
        } catch { /* niepełna linia */ }
      }
    };
    xhr.onprogress = () => parseLines(xhr.responseText);
    const fail = (msg: string) => { appLog.logCall({ ts: Date.now(), label: "scan", ok: false, ms: Date.now() - t0, detail: msg }); reject(new Error(msg)); };
    xhr.onerror = () => fail("Błąd sieci podczas skanu.");
    xhr.ontimeout = () => fail("Skan trwał za długo (timeout).");
    xhr.onload = () => {
      appLog.logCall({ ts: Date.now(), label: "scan", ok: xhr.status >= 200 && xhr.status < 300, ms: Date.now() - t0, detail: xhr.status >= 200 && xhr.status < 300 ? undefined : `HTTP ${xhr.status}` });
      const text = xhr.responseText || "";
      let result: { menu?: Menu; usage?: Usage; error?: string; cached?: boolean } | null = null;
      for (const line of text.split("\n")) {
        const tt = line.trim();
        if (!tt) continue;
        try { const ev = JSON.parse(tt); if (ev.menu || ev.error || ev.done) result = ev; } catch { /* keepalive */ }
      }
      if (!result) return fail("Połączenie przerwane w trakcie skanu — spróbuj ponownie.");
      if (xhr.status < 200 || xhr.status >= 300 || result.error) return fail(result.error ?? `Błąd serwera (HTTP ${xhr.status})`);
      if (!result.menu) return fail("Pusta odpowiedź serwera.");
      resolve({ menu: result.menu, usage: result.usage ?? ZERO_USAGE, cached: !!result.cached });
    };
    xhr.send(JSON.stringify({ sessionId, stream: true }));
  });
}

export interface DishInfoParams {
  name: string;
  description?: string;
  restaurant?: string;
  cuisine?: string;
  location?: string;
  targetLang: string;
  model: ModelId;
}

export interface PeekResult {
  isMenu: boolean;
  cuisine: string;
  restaurantName: string;
  /** Czy ze zdjęcia da się cokolwiek odczytać. false = za słaba jakość. */
  readable: boolean;
  /** Serwer uznał kadr za zły (za słaba jakość) — nie warto skanować/wysyłać. */
  bad: boolean;
  /** Miękki znacznik: odczytano, ale jakość słaba (wynik może być niepełny) — ostrzeż, nie wyklucz. */
  partial?: boolean;
  /** Hash zdjęcia (z serwera) — identyfikacja „złego kadru". */
  imageHash?: string;
}

/** „Szybki podgląd" — lekka ocena 1 zdjęcia (kuchnia / nazwa / czy to menu). Tani model. */
export async function quickPeek(
  image: { base64: string; mediaType: string },
  model: string,
): Promise<PeekResult> {
  const res = await loggedFetch("quick-peek", `${API_BASE}/quick-peek`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ image, model }),
  });
  const json = (await res.json()) as Partial<PeekResult> & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return {
    isMenu: !!json.isMenu,
    cuisine: json.cuisine ?? "",
    restaurantName: json.restaurantName ?? "",
    readable: json.readable !== false,
    bad: json.bad === true,
    imageHash: json.imageHash,
  };
}

export async function fetchDishInfo(
  params: DishInfoParams,
): Promise<{ info: string; usage: Usage }> {
  const res = await loggedFetch("dish-info", `${API_BASE}/dish-info`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { info?: string; usage?: Usage; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  if (!json.info) throw new Error("Pusta odpowiedź serwera.");
  return { info: json.info, usage: json.usage ?? ZERO_USAGE };
}

const LANG_CODES: Record<string, string> = {
  polski: "pl",
  English: "en",
  Deutsch: "de",
  "Español": "es",
};

export interface RestaurantQuery {
  name?: string; // opcjonalna — gdy brak, serwer szuka po GPS + kuchni
  address?: string;
  cuisine?: string;
  location?: GeoPoint | null;
  targetLang?: string;
  forceNearby?: boolean; // wymuś szukanie po okolicy (ignoruje nazwę)
  radius?: number; // zasięg „w pobliżu" w metrach
}

/** Zwraca najlepszy lokal + ewentualnych kandydatów (gdy zgadywano po lokalizacji). */
export async function fetchRestaurant(
  q: RestaurantQuery,
): Promise<{ restaurant: RestaurantInfo | null; candidates: RestaurantInfo[] }> {
  const res = await loggedFetch("restaurant", `${API_BASE}/restaurant`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: q.forceNearby ? undefined : q.name,
      address: q.address,
      cuisine: q.cuisine,
      lat: q.location?.lat,
      lng: q.location?.lng,
      lang: q.targetLang ? LANG_CODES[q.targetLang] ?? "pl" : "pl",
      radius: q.radius,
    }),
  });
  const json = (await res.json()) as {
    restaurant?: RestaurantInfo | null;
    candidates?: RestaurantInfo[];
    error?: string;
  };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { restaurant: json.restaurant ?? null, candidates: json.candidates ?? [] };
}

/** URL do proxy zdjęcia lokalu (klucz Google zostaje na serwerze). */
export function placePhotoUrl(photoName: string, width = 800): string {
  // Token w query (?t=), bo zdjęcie ładuje <Image>/pobieranie pliku — bez nagłówków.
  const tok = APP_TOKEN ? `&t=${encodeURIComponent(APP_TOKEN)}` : "";
  return `${API_BASE}/place-photo?name=${encodeURIComponent(photoName)}&w=${width}${tok}`;
}

export interface VenueMatch {
  dish: string;
  source: "google" | "tripadvisor";
  photoName?: string; // Google: nazwa zasobu (→ placePhotoUrl)
  url?: string; // TripAdvisor: bezpośredni URL
  caption: string | null;
  confidence: number;
}

/** Tier 0: pula zdjęć z lokalu (Google Places + TripAdvisor) → wizja → ★ dopasowania do dań. */
export async function fetchVenuePhotos(
  photoNames: string[],
  taPhotos: { url: string; caption: string | null }[],
  dishes: string[],
  cuisine?: string,
  model?: string,
  certain = true,
): Promise<{ matches: VenueMatch[]; usage: Usage }> {
  const res = await loggedFetch("venue-photos", `${API_BASE}/venue-photos`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ photoNames, taPhotos, dishes, cuisine, model, certain }),
  });
  const json = (await res.json()) as { matches?: VenueMatch[]; usage?: Usage; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { matches: json.matches ?? [], usage: json.usage ?? ZERO_USAGE };
}

export async function fetchDishPhotos(
  dish: string,
  restaurantHint?: string,
  opts?: { representativeOnly?: boolean; num?: number; cuisine?: string; website?: string; restaurantName?: string; city?: string; taLocationId?: string; branded?: boolean; photoQuery?: string; photoQueryLocal?: string; verifyModel?: string },
): Promise<{ photos: DishPhotoLite[]; usage: Usage; debug?: PhotoDebug }> {
  const res = await loggedFetch("dish-photos", `${API_BASE}/dish-photos`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      dish,
      restaurantHint,
      restaurantName: opts?.restaurantName,
      city: opts?.city,
      taLocationId: opts?.taLocationId,
      branded: opts?.branded,
      photoQuery: opts?.photoQuery,
      photoQueryLocal: opts?.photoQueryLocal,
      cuisine: opts?.cuisine,
      website: opts?.website,
      num: opts?.num ?? 4,
      representativeOnly: opts?.representativeOnly,
      verifyModel: opts?.verifyModel,
    }),
  });
  const json = (await res.json()) as { photos?: DishPhotoLite[]; usage?: Usage; debug?: PhotoDebug; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { photos: json.photos ?? [], usage: json.usage ?? ZERO_USAGE, debug: json.debug };
}

// --- Diagnostyka: zewnętrzne API używane przez serwer ---
export interface DiagEntry {
  ts: number;
  op: string;
  ok: boolean;
  ms: number;
  detail?: string;
}
export interface DiagProvider {
  provider: string;
  label: string;
  paid: boolean;
  configured: boolean;
  total: number;
  ok: number;
  errors: number;
  lastAt: number | null;
  lastError: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  bytesSent: number; // wysłane przez serwer (egress — płatne na Railway)
  bytesRecv: number; // odebrane przez serwer (ingress)
  entries: DiagEntry[];
}

export interface DiagTotals {
  bytesSent: number;
  bytesRecv: number;
  costUsd: number;
  egressUsdPerGB?: number;
  dataCostUsd?: number;
  grandTotalUsd?: number;
}

/** Pobiera log/statystyki zewnętrznych API z serwera (ekran Diagnostyka). */
export async function fetchDiagnostics(): Promise<{ now: number; providers: DiagProvider[]; totals?: DiagTotals }> {
  const res = await loggedFetch("diagnostics", `${API_BASE}/diagnostics`, { headers: jsonHeaders() });
  const json = (await res.json()) as { now?: number; providers?: DiagProvider[]; totals?: DiagTotals; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { now: json.now ?? Date.now(), providers: json.providers ?? [], totals: json.totals };
}

// --- Trwałe statystyki (Postgres) — przeżywają redeploy ---
export interface DiagStats {
  enabled: boolean;
  since?: string | null;
  totalScans?: number;
  totalDishes?: number;
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  byModel?: { model: string | null; calls: number; scans: number; cost: number; inputTokens: number; outputTokens: number }[];
  byOp?: { op: string | null; calls: number; cost: number; inputTokens: number; outputTokens: number }[];
  byDay?: { day: string; scans: number }[];
  recentErrors?: { at: string; provider: string | null; op: string | null; detail: string | null }[];
  errors?: number;
  todayCostUsd?: number;
  dailyBudgetUsd?: number | null;
}

/** Surowe zdarzenie z trwałego logu (Postgres). */
export interface DiagEvent {
  id: string | number;
  created_at: string;
  type: string;
  op: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  data?: Record<string, unknown> | null;
}

export async function fetchStats(): Promise<DiagStats> {
  const res = await loggedFetch("stats", `${API_BASE}/stats`, { headers: jsonHeaders() });
  const json = (await res.json()) as DiagStats & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return json;
}

/** Wysyła migawkę (zip base64 + hash + meta) na serwer — lab ją potem zaimportuje. */
export async function uploadSample(
  hash: string,
  meta: Record<string, unknown>,
  zipBase64: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const res = await loggedFetch("samples-upload", `${API_BASE}/samples`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ hash, meta, zipBase64 }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  return { ok: true, status: json.status };
}

/** Stan migawek po hashach: na serwerze? zaimportowane? (do znaczników w „Trybie testowym"). */
export async function fetchSampleStatus(hashes: string[]): Promise<Record<string, { onServer: boolean; imported: boolean }>> {
  if (hashes.length === 0) return {};
  const res = await loggedFetch("samples-status", `${API_BASE}/samples/status`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ hashes }),
  }).catch(() => null);
  if (!res || !res.ok) return {};
  const json = (await res.json().catch(() => ({}))) as { status?: Record<string, { onServer: boolean; imported: boolean }> };
  return json.status ?? {};
}

export interface ServerSampleInfo { id: number; hash: string; meta: Record<string, unknown>; bytes: number; createdAt: string }

/** Sample czekające NA IMPORT W APCE (wypchnięte z labu, target='app'). */
export async function fetchAppServerSamples(): Promise<ServerSampleInfo[]> {
  const res = await loggedFetch("app-samples", `${API_BASE}/samples?pending=1&target=app`, { headers: jsonHeaders() }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = (await res.json().catch(() => ({}))) as { samples?: ServerSampleInfo[] };
  return json.samples ?? [];
}

/** Pobiera zip sampla (surowe bajty) do importu w apce — JSZip ładuje Uint8Array wprost. */
export async function downloadServerSampleZip(id: number): Promise<Uint8Array | null> {
  const res = await loggedFetch("app-sample-zip", `${API_BASE}/samples/${id}/zip`, { headers: jsonHeaders() }).catch(() => null);
  if (!res || !res.ok) return null;
  const buf = await res.arrayBuffer().catch(() => null);
  return buf ? new Uint8Array(buf) : null;
}

/** Usuwa sampel z serwera (po imporcie do apki — żeby zniknął z kolejki). */
export async function deleteServerSample(id: number): Promise<boolean> {
  const res = await loggedFetch("app-sample-del", `${API_BASE}/samples/${id}`, { method: "DELETE", headers: jsonHeaders() }).catch(() => null);
  return !!res && res.ok;
}

/** Surowe ostatnie zdarzenia z trwałego logu (feed aktywności + eksport debug). */
export async function fetchEvents(limit = 500): Promise<DiagEvent[]> {
  const res = await loggedFetch("events", `${API_BASE}/events?limit=${limit}`, { headers: jsonHeaders() });
  const json = (await res.json()) as { events?: DiagEvent[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return json.events ?? [];
}
