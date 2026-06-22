import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  scanMenu,
  enrichMenuOnServer,
  scanStart,
  scanUploadPhoto,
  scanRun,
  setScanSession,
  setSessionCostHandler,
  type ScanPhase,
  type ScanItemStub,
  fetchDishInfo,
  fetchDishPhotos,
  fetchRestaurant,
  fetchVenuePhotos,
  quickPeek,
  placePhotoUrl,
  reportError,
  registerInstall,
  initForceFresh,
  type VenueMatch,
  type PeekResult,
} from "./src/api";
import { cacheImage, cachePhotos, resolveCachedUri } from "./src/imageCache";
import { mergeMenus } from "./src/mergeMenu";
import {
  captureFromCamera,
  pickFromLibrary,
  prepareCameraPhoto,
  MAX_IMAGES,
  SCAN_BATCH,
  type PreparedImage,
} from "./src/image";
import { getCurrentLocation, reverseGeocode } from "./src/location";
import {
  listScans,
  saveScan,
  deleteScan,
  updateScanItem,
  updateScanMenu,
  setScanSourcePhotos,
  setScanSessionId,
  updateScanRestaurant,
  addScanUsage,
  setScanCost,
  renameScan,
  clearScanRestaurant,
  loadModelPrefs,
  saveModelPrefs,
  loadLangPref,
  saveLangPref,
  loadPeekPref,
  savePeekPref,
  loadCostPrefs,
  saveCostPrefs,
  DEFAULT_COST_PREFS,
  type CostPrefs,
  type SavedScan,
} from "./src/storage";
import {
  listCaptures,
  saveCapture,
  addCaptureRun,
  captureImageBase64,
  resolveCaptureUri,
  persistScanImages,
  deleteScanImages,
  type ScanCapture,
} from "./src/captures";
import { MenuView } from "./src/MenuView";
import { VenueSearchScreen } from "./src/VenueSearchScreen";
import { Lightbox, type LightboxState } from "./src/Lightbox";
import { HistoryView } from "./src/HistoryView";
import { DiagnosticsView } from "./src/DiagnosticsView";
import { CapturesView } from "./src/CapturesView";
import { SettingsView } from "./src/SettingsView";
import { PricingView } from "./src/PricingView";
import { CameraCapture } from "./src/CameraCapture";
import { ApiErrorToast } from "./src/Toast";
import { friendlyMessage } from "./src/appLog";
import { RenameModal } from "./src/RenameModal";
import { RestaurantCard } from "./src/RestaurantCard";
import { colors } from "./src/theme";
import {
  DEFAULT_MODELS,
  MODEL_OPTIONS,
  ZERO_USAGE,
  addUsage,
  type DishPhotoLite,
  type GeoPoint,
  type LocationSource,
  type Menu,
  type MenuItem,
  type ModelId,
  type ModelRole,
  type PhotoDebug,
  type RestaurantInfo,
  type TripAdvisorPhoto,
  type Usage,
} from "./src/types";

// Domyślny zasięg szukania lokalu „w pobliżu" (m). Można zwiększać „szerszym zasięgiem".
const DEFAULT_NEARBY_RADIUS = 800;
// Mały promień do listy „w pobliżu" wysyłanej do vision przy skanie (venue_match) — na błąd GPS, mała
// lista = mniej szumu. Większy zasięg jest tylko w ręcznym „Znajdź inny".
const VENUE_MATCH_RADIUS = 220;
// Ile zdjęć poglądowych TRZYMAĆ per danie. Serwer i tak WERYFIKUJE wizją ~9 kandydatów (cap = max(num·3,9)),
// więc 3 zamiast 1 jest DARMOWE (ta sama weryfikacja) — tylko nie wyrzucamy reszty dobrych. Galeria dania
// (InfoFooter) pokazuje je paskiem; wcześniej marnowaliśmy już zweryfikowane fotki.
const REPR_PER_DISH = 3;

// Czytelna etykieta modelu (np. „Gemini 2.5 Flash”) z id — do panelu „Ustawienia menu”.
function modelLabel(id: ModelId | undefined | null): string {
  if (!id) return "—";
  return MODEL_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

// Normalizacja do dopasowania nazwy dania z podpisem zdjęcia TripAdvisor.
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Zdjęcia z TripAdvisor, których podpis zawiera nazwę dania (prawdziwe, z tego lokalu). */
function matchTaPhotos(dishName: string, taPhotos: TripAdvisorPhoto[] | undefined): DishPhotoLite[] {
  const needle = norm(dishName);
  if (!needle || !taPhotos) return [];
  return taPhotos
    .filter((p) => p.caption && norm(p.caption).includes(needle))
    .map((p) => ({ url: p.url, source: "tripadvisor", attribution: "TripAdvisor", verified: true }));
}

type Status = "idle" | "scanning" | "done" | "error";
type Tab = "scan" | "history";

// Globalny handler błędów RN → zgłoś KAŻDY niewyłapany błąd na serwer (zakładka „Błędy" w labie),
// zachowując domyślne zachowanie apki. Ustawiany raz, na poziomie modułu.
const _EU = (globalThis as unknown as { ErrorUtils?: { setGlobalHandler?: (h: (e: unknown, f?: boolean) => void) => void; getGlobalHandler?: () => ((e: unknown, f?: boolean) => void) | undefined } }).ErrorUtils;
if (_EU?.setGlobalHandler) {
  const _prev = _EU.getGlobalHandler?.();
  _EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const err = error as { message?: string; stack?: string } | undefined;
    try { reportError(err?.message ?? String(error), { stack: err?.stack, label: isFatal ? "fatal" : "uncaught", context: { isFatal: !!isFatal } }); } catch { /* ignoruj */ }
    _prev?.(error, isFatal);
  });
}

// Faza skanu → krótki, „żywy" opis kroku + ewentualny % wysyłki (do paska postępu).
function scanPhaseLabel(p: ScanPhase): { label: string; pct?: number } {
  switch (p.phase) {
    case "uploading":
      return { label: `Wysyłanie zdjęć… ${Math.round(p.pct * 100)}%`, pct: p.pct };
    case "received":
      return { label: "Serwer odebrał — model czyta menu…" };
    case "extracting":
      return {
        label: p.items && p.items > 0
          ? `Odczytano ${p.items} pozycji… (${Math.round(p.elapsedMs / 1000)} s)`
          : `Model czyta menu… ${Math.round(p.elapsedMs / 1000)} s`,
      };
    case "finalizing":
      return { label: "Składam wynik…" };
  }
}

// Notka z „szybkiego podglądu" (quick peek) pod zdjęciem w Lightboxie — kuchnia/lokal/jakość, jeśli są.
function peekNote(p?: PeekResult): string | undefined {
  if (!p) return undefined;
  const parts: string[] = [];
  if (p.bad || !p.readable) parts.push("⚠️ słaba jakość — model może nie odczytać");
  else if (p.partial) parts.push("⚠️ jakość słaba — wynik może być niepełny");
  if (p.isMenu === false) parts.push("📷 to chyba nie menu");
  if (p.cuisine?.trim()) parts.push(`🍽 ${p.cuisine.trim()}`);
  if (p.restaurantName?.trim()) parts.push(`🏠 ${p.restaurantName.trim()}`);
  return parts.length ? parts.join("  ·  ") : undefined;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("scan");
  const [openScan, setOpenScan] = useState<SavedScan | null>(null);
  const [sourceLb, setSourceLb] = useState<LightboxState | null>(null); // podgląd zdjęć źródłowych skanu
  const [showDiag, setShowDiag] = useState(false);
  const [showCaptures, setShowCaptures] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [captures, setCaptures] = useState<ScanCapture[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  // Postęp analizy gdy skan idzie partiami (duże menu). null = brak/jedna partia.
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  // Faza bieżącej partii skanu (wysyłka % → model czyta z licznikiem) — żywy sygnał postępu.
  const [scanPhase, setScanPhase] = useState<{ label: string; pct?: number } | null>(null);
  // Czy choć jedna partia skanu wróciła Z CACHE (ten sam plik) — do informacji o oszczędności.
  const [scanFromCache, setScanFromCache] = useState(false);
  // Nazwa lokalu wykryta NA ŻYWO w trakcie skanu (z szyldu/okładki) — pokazujemy od razu.
  const [scanFoundName, setScanFoundName] = useState<string | null>(null);
  // Pozycje pojawiające się NA ŻYWO w trakcie skanu (mini-karty: nazwa, cena, opis, miniatura).
  const [scanItems, setScanItems] = useState<
    { original: string; translated: string; branded: boolean; price: string | null; currency: string | null; description: string; photo?: string }[]
  >([]);
  // Prefetch tanich zdjęć poglądowych podczas skanu — reużywane po skanie (bez ponownego szukania).
  const prefetchedPhotos = useRef<Map<string, DishPhotoLite[]>>(new Map());
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetLang, setTargetLang] = useState("polski");
  const [hint, setHint] = useState("");
  // Czy „Lokal" wpisał użytkownik (true) czy auto-uzupełnił peek (false). Auto-lokal czyścimy przy
  // starcie nowego skanu (puste zdjęcia) — żeby NIE przeciekał z poprzedniego skanu do nowej migawki.
  const [hintManual, setHintManual] = useState(false);
  // Replay z migawki: wymusza DOKŁADNIE zapisaną lokalizację (eksperyment na starej próbce — aktualna
  // pozycja nie ma sensu). Czyszczone przy nowych zdjęciach / resecie → wraca do lokalizacji na żywo.
  const [replayLocation, setReplayLocation] = useState<{ location: GeoPoint | null; locationSource: LocationSource; locationHint?: string } | null>(null);
  const [useDeviceLocation, setUseDeviceLocation] = useState(true);
  const [useExifLocation, setUseExifLocation] = useState(true);
  const [showOptions, setShowOptions] = useState(false); // zwijane „Opcje skanu" (lokal + lokalizacja)
  const [showCamera, setShowCamera] = useState(false); // własny ekran aparatu (z podglądem zdjęcia)
  const [peekEnabled, setPeekEnabled] = useState(true); // „szybki podgląd" na żywo (kuchnia/nazwa)
  const [peekInfo, setPeekInfo] = useState<PeekResult | null>(null);
  const [peekByUri, setPeekByUri] = useState<Record<string, PeekResult>>({}); // ocena peek per zdjęcie sesji
  const [peekingUris, setPeekingUris] = useState<string[]>([]); // które zdjęcia są AKTUALNIE analizowane (równolegle)
  const [costPrefs, setCostPrefs] = useState<CostPrefs>(DEFAULT_COST_PREFS); // kontrola auto-kosztu po skanie
  const [showPricing, setShowPricing] = useState(false); // strona „Cennik"
  const [showVenueSearch, setShowVenueSearch] = useState(false); // osobny ekran „Znajdź lokal" (mapa + szukanie)
  const [sessionCost, setSessionCost] = useState(0); // LIVE koszt sesji (z nagłówka x-session-cost) — rośnie w trakcie
  // Model AI osobno per miejsce użycia (skan/opisy/weryfikacja/venue) — patrz Ustawienia.
  const [models, setModels] = useState<Record<ModelRole, ModelId>>(DEFAULT_MODELS);

  const [scans, setScans] = useState<SavedScan[]>([]);
  const [freshScanId, setFreshScanId] = useState<string | null>(null);
  const [infoLoading, setInfoLoading] = useState<Set<string>>(new Set()); // generowanie opisu
  const [photoLoading, setPhotoLoading] = useState<Set<string>>(new Set()); // doszukiwanie lepszych zdjęć
  const [freshRestaurant, setFreshRestaurant] = useState<RestaurantInfo | null>(null);
  const [restaurantLoading, setRestaurantLoading] = useState(false);
  // #2a: lokal namierzany JUŻ w trakcie struktury (read-only), a podmiana ★ zdjęć (mutacja menu) odkładana
  // na zamrożoną strukturę. Refy łączą wczesny lookup (bez scanId) z finalizacją po Fazie A.
  const earlyVenueRef = useRef(false); // czy wczesny lookup już ruszył (raz na skan)
  const scanIdRef = useRef<string | null>(null); // scanId dostępny dla wczesnych callbacków
  // Do którego skanu utrwalać LIVE koszt sesji z serwera (świeży skan lub otwarty z historii — sesja
  // serwera przełącza się z nim). + timer debounce, by nie pisać do storage przy każdym nagłówku.
  const activeCostScanRef = useRef<string | null>(null);
  const costPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ID SESJI usera (od „nowy skan" do „nowy skan"). Zapisywany w skanie; po otwarciu z historii wracamy
  // do niej, by dorabiane ops trafiły do tej samej sesji w statystykach.
  const sessionIdRef = useRef<string>("");
  const newSession = (): string => { const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; sessionIdRef.current = id; setScanSession(id); setSessionCost(0); return id; };
  const structureFrozenRef = useRef(false); // czy struktura zamrożona (można robić upgrade ★)
  const structureMenuRef = useRef<Menu | null>(null); // zamrożona struktura do upgrade'u
  const freshVenueRef = useRef<RestaurantInfo | null>(null); // ostatni znaleziony lokal (dla finalizacji)
  const scanGenRef = useRef(0); // generacja skanu — rośnie z każdym runScan; odsiewa spóźnione callbacki starych skanów
  const replayCaptureIdRef = useRef<string | null>(null); // replay z migawki → REUŻYJ tej migawki (nie twórz nowej)
  const venueFinalizedRef = useRef(false); // czy lokal zapisany do skanu (raz na skan)
  const previewStartedRef = useRef(false); // czy ruszyło dociąganie TANICH poglądowych (★ z lokalu czeka na to)
  const venueUpgradedRef = useRef(false); // czy ★ z lokalu już podmieniane (raz na skan)
  useEffect(() => { freshVenueRef.current = freshRestaurant; }, [freshRestaurant]);
  // Kontekst aktywnej karty lokalu: pozwala wybrać kandydata, wyszukać inny lokal
  // w pobliżu i usunąć dopasowanie — niezależnie od tego, czy to świeży czy zapisany skan.
  const [restaurantCtx, setRestaurantCtx] = useState<{
    menu: Menu;
    location: GeoPoint | null;
    scanId: string | null;
    lang: string;
    apply: (r: RestaurantInfo | null) => void;
    // Setter MENU właściwego stanu (świeży / otwarty) — do doszukania zdjęć z lokalu.
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void;
    // Aktualnie dopasowany lokal — by wykryć ZMIANĘ (inne placeId) i odświeżyć ★ zdjęcia.
    current: RestaurantInfo | null;
    candidates: RestaurantInfo[];
    radius?: number; // ostatnio użyty zasięg „w pobliżu" (do „szerszego")
  } | null>(null);
  // Trwa szukanie lokali w pobliżu (nie blokuje karty — lekki wskaźnik przy liście).
  const [nearbyLoading, setNearbyLoading] = useState(false);
  // Skan, którego nazwę aktualnie edytujemy (modal).
  const [renameTarget, setRenameTarget] = useState<SavedScan | null>(null);
  // Trwa dokładanie nowych zdjęć do istniejącego menu.
  const [appending, setAppending] = useState(false);
  // „Przejdź do menu" w trakcie skanu — user czyta gotowe pozycje, reszta dochodzi w tle.
  const [browseEarly, setBrowseEarly] = useState(false);
  // Struktura wszystkich stron złożona i ZAMROŻONA (Faza A gotowa) → pokaż „Otwórz menu" + kartę lokalu.
  const [structureReady, setStructureReady] = useState(false);

  useEffect(() => {
    setSessionCostHandler((n) => {
      setSessionCost((prev) => Math.max(prev, n)); // koszt sesji rośnie monotonicznie
      // Utrwal AUTORYTATYWNY koszt sesji do aktywnego skanu (debounce 1.5s) → historia pokaże realny koszt
      // (z doszukiwaniem zdjęć/opisów/lokalu), nie tylko początkową strukturę. Odśwież listę po zapisie.
      const sid = activeCostScanRef.current;
      if (!sid) return;
      if (costPersistTimer.current) clearTimeout(costPersistTimer.current);
      costPersistTimer.current = setTimeout(() => {
        void setScanCost(sid, n).then((changed) => { if (changed) void listScans().then(setScans); });
      }, 1500);
    });
    newSession(); // sesja od startu apki
    void registerInstall(); // GUID instalacji + rejestracja urządzenia/wersji + kolejka błędów offline
    void initForceFresh(); // wczytaj debugowy tryb „bez cache" (jeśli włączony wcześniej)
    listScans().then(setScans).catch(() => {});
    listCaptures().then(setCaptures).catch(() => {});
    // Przywróć zapamiętane modele per miejsce (brakujące pola uzupełniamy domyślnymi).
    loadModelPrefs()
      .then((saved) => setModels((prev) => ({ ...prev, ...saved })))
      .catch(() => {});
    loadLangPref()
      .then((l) => {
        if (l) setTargetLang(l);
      })
      .catch(() => {});
    loadPeekPref().then(setPeekEnabled).catch(() => {});
    loadCostPrefs().then(setCostPrefs).catch(() => {});
  }, []);

  function changeCostPrefs(next: CostPrefs) {
    setCostPrefs(next);
    void saveCostPrefs(next).catch(() => {});
  }

  function togglePeek(on: boolean) {
    setPeekEnabled(on);
    void savePeekPref(on).catch(() => {});
  }

  // Zdjęcia przygotowane JUŻ przy zamrożeniu kadru (freeze) — żeby peek poszedł od razu, a „✓ Użyj"
  // tylko je dołożyło (bez ponownego przygotowania i bez DRUGIEGO peeka, który kosztuje).
  const preparedAtFreeze = useRef<Map<string, PreparedImage>>(new Map());

  // Przycisk „Aparat": zawsze nasz własny ekran aparatu (podgląd każdego zdjęcia + dodawanie serii).
  function openCamera() {
    setPeekInfo(null); // świeża sesja podglądu
    preparedAtFreeze.current.clear(); // świeża sesja → wyczyść cache z poprzedniej
    setShowCamera(true);
  }

  // Freeze: użytkownik zrobił zdjęcie i czeka na decyzję → OD RAZU przygotuj + peek (nie czekamy na „Użyj").
  async function onCameraFreeze(uri: string, exif?: Record<string, unknown> | null) {
    try {
      const img = await prepareCameraPhoto(uri, exif);
      preparedAtFreeze.current.set(uri, img);
      if (peekEnabled) void runPeek(img); // peek na zamrożonym kadrze — wynik dojdzie, gdy user patrzy
    } catch {
      // przygotowanie nie wyszło — „Użyj" spróbuje ponownie (fallback w onSerialCapture)
    }
  }

  // „Szybki podgląd": lekka ocena 1 zdjęcia (kuchnia/nazwa) tanim modelem; auto-wstawia nazwę do pola Lokal.
  // Najczęstsza kuchnia rozpoznana przez „szybki podgląd" (kontekst dla skanu).
  function pickPeekCuisine(): string | undefined {
    const counts = new Map<string, number>();
    for (const r of Object.values(peekByUri)) {
      const c = r.cuisine?.trim();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [c, n] of counts) if (n > bestN) ((best = c), (bestN = n));
    return best ?? (peekInfo?.cuisine?.trim() || undefined);
  }

  // Każde wywołanie jest NIEZALEŻNE (fire-and-forget) → analizy lecą RÓWNOLEGLE i nie
  // przerywają się; wynik każdego dopisuje się po uri (galeria/banner aktualizują się na bieżąco).
  async function runPeek(img: PreparedImage) {
    setPeekingUris((p) => [...p, img.uri]);
    try {
      const r = await quickPeek({ base64: img.base64, mediaType: img.mediaType }, models.peek, img.srcHash);
      setPeekInfo(r);
      setPeekByUri((prev) => ({ ...prev, [img.uri]: r })); // ocena dla tego konkretnego zdjęcia
      setHint((h) => (h.trim() ? h : r.restaurantName || h)); // nie nadpisuj, gdy user już coś wpisał
    } catch {
      // podgląd jest tylko pomocniczy — błąd ignorujemy
    } finally {
      setPeekingUris((p) => p.filter((u) => u !== img.uri));
    }
  }

  // „✓ Użyj": dołóż zdjęcie. Zwykle jest już PRZYGOTOWANE i ZPEEKOWANE przy freeze → reużywamy
  // (bez ponownego przygotowania i bez drugiego peeka). Fallback: gdyby freeze nie zdążył/nie wyszedł.
  async function onSerialCapture(uri: string, exif?: Record<string, unknown> | null) {
    try {
      const pre = preparedAtFreeze.current.get(uri);
      preparedAtFreeze.current.delete(uri);
      const img = pre ?? (await prepareCameraPhoto(uri, exif));
      setReplayLocation(null); // nowe zdjęcie z aparatu → przestajemy wymuszać lokalizację z migawki
      setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, img]));
      if (!pre && peekEnabled) void runPeek(img); // peek tylko gdy NIE poszedł przy freeze (bez podwójnego)
    } catch {
      // pojedyncze zdjęcie nie przeszło — ignoruj, można pstryknąć ponownie
    }
  }

  // Zmiana modelu dla jednego miejsca + zapamiętanie.
  function changeModel(role: ModelRole, m: ModelId) {
    setModels((prev) => {
      const next = { ...prev, [role]: m };
      void saveModelPrefs(next).catch(() => {});
      return next;
    });
  }

  // Ustawia WSZYSTKIE role naraz (presety / „ustaw wszędzie" / reset do domyślnych) + zapis.
  function setModelsAll(next: Record<ModelRole, ModelId>) {
    setModels(next);
    void saveModelPrefs(next).catch(() => {});
  }

  // Zmiana domyślnego języka tłumaczenia + zapamiętanie.
  function changeLang(lang: string) {
    setTargetLang(lang);
    void saveLangPref(lang).catch(() => {});
  }

  function addImages(toAdd: PreparedImage[]) {
    if (toAdd.length === 0) return;
    setReplayLocation(null); // ręcznie dodane zdjęcia → lokalizacja na żywo (to już nie czysty replay)
    setImages((prev) => [...prev, ...toAdd].slice(0, MAX_IMAGES));
  }

  async function addFromCamera() {
    setError(null);
    try {
      const img = await captureFromCamera();
      if (img) addImages([img]);
    } catch (e) {
      setError(friendlyMessage(e instanceof Error ? e.message : undefined));
    }
  }

  async function addFromLibrary() {
    setError(null);
    try {
      addImages(await pickFromLibrary());
    } catch (e) {
      setError(friendlyMessage(e instanceof Error ? e.message : undefined));
    }
  }

  // Po zejściu do 0 zdjęć (start nowego skanu) porzuć AUTO-uzupełniony „Lokal" — żeby nie przeciekł
  // z poprzedniego skanu. Ręcznie wpisany lokal zostaje (intencja użytkownika).
  function clearAutoHintIfEmpty(remaining: number) {
    if (remaining === 0 && !hintManual) { setHint(""); setPeekInfo(null); }
  }

  function removeImage(index: number) {
    const next = images.filter((_, i) => i !== index);
    setImages(next);
    clearAutoHintIfEmpty(next.length);
  }

  // Usuwa zdjęcie po uri (z galerii aparatu) + sprząta jego ocenę peek.
  function removeImageByUri(uri: string) {
    const next = images.filter((i) => i.uri !== uri);
    setImages(next);
    clearAutoHintIfEmpty(next.length);
    setPeekByUri((prev) => {
      const n = { ...prev };
      delete n[uri];
      return n;
    });
    setPeekingUris((p) => p.filter((u) => u !== uri));
  }

  // Skan przy bieżących ustawieniach ekranu (przycisk „Przetłumacz menu").
  // Replay z migawki → wymuszamy zapisaną lokalizację (fixedLocation), żeby eksperyment szedł na
  // IDENTYCZNYM wejściu co kiedyś, a nie na aktualnej pozycji użytkownika.
  async function doScan() {
    // Wyklucz „złe kadry" — zdjęcia, które peek uznał za za słabej jakości (nie da się nic odczytać).
    const good = images.filter((img) => !peekByUri[img.uri]?.bad);
    if (good.length === 0) {
      Alert.alert("Za słaba jakość", "Wszystkie zdjęcia są zbyt słabej jakości, by cokolwiek odczytać. Zrób ostrzejsze/jaśniejsze zdjęcia menu.");
      return;
    }
    if (good.length < images.length) {
      Alert.alert("Pominięto słabe zdjęcia", `${images.length - good.length} zdjęć było za słabej jakości — zeskanuję tylko ${good.length} czytelnych.`);
    }
    await runScan({ images: good, targetLang, models, hint, useExifLocation, useDeviceLocation, fixedLocation: replayLocation ?? undefined });
  }

  // Rdzeń skanu — wspólny dla zwykłego skanu i „Wyślij ponownie" (tryb testowy).
  // `fixedLocation` (replay) używa DOKŁADNIE tej samej pozycji co zapisana migawka,
  // żeby ponowny skan szedł na identycznym wejściu (bez ponownego liczenia GPS/EXIF).
  async function runScan(opts: {
    images: PreparedImage[];
    targetLang: string;
    models: Record<ModelRole, ModelId>;
    hint: string;
    useExifLocation: boolean;
    useDeviceLocation: boolean;
    fixedLocation?: { location: GeoPoint | null; locationSource: LocationSource; locationHint?: string };
    // Replay odtwarza istniejącą migawkę → nie tworzymy kolejnej (uniknięcie duplikatów).
    recordCapture?: boolean;
  }) {
    if (opts.images.length === 0) return;
    setError(null);
    setStatus("scanning");
    setBrowseEarly(false);
    setStructureReady(false);
    earlyVenueRef.current = false; // #2a: reset cyklu życia lokalu
    scanIdRef.current = null;
    activeCostScanRef.current = null; // dopóki nie ma scanId, nie utrwalaj kosztu do POPRZEDNIEGO skanu
    structureFrozenRef.current = false;
    structureMenuRef.current = null;
    freshVenueRef.current = null;
    venueFinalizedRef.current = false;
    previewStartedRef.current = false;
    venueUpgradedRef.current = false;
    setScanFoundName(null); // nie pokazuj nazwy lokalu z POPRZEDNIEGO skanu
    const myGen = (scanGenRef.current += 1); // generacja tego skanu — odsiewa SPÓŹNIONE callbacki starych skanów
    // Domknięcie wczesnego lokalu (karta + zapis ★). STRAŻNIK generacji: spóźniony lokal STAREGO skanu nie
    // może zatruć bieżącego ani nie wskoczy do złego scanId (przeciek nazwy lokalu między skanami).
    const applyEarlyVenue = (r: RestaurantInfo | null) => {
      if (myGen !== scanGenRef.current) return; // inny skan już trwa → ignoruj wynik starego
      setFreshRestaurant(r);
      freshVenueRef.current = r;
      if (r && structureFrozenRef.current && scanIdRef.current && structureMenuRef.current) {
        void finalizeVenue(structureMenuRef.current, scanIdRef.current, r);
      }
    };
    setScanPhase({ label: "Przygotowuję wysyłkę…" });
    try {
      // Źródła lokalizacji (oba opcjonalne):
      //  1) EXIF zdjęcia — najlepsze, bo wskazuje GDZIE zrobiono zdjęcie (lokal),
      //     działa nawet gdy skanujesz później.
      //  2) GPS urządzenia — pozycja użytkownika (kraj/miasto, też gdy nie w lokalu).
      let location: GeoPoint | null = null;
      let locationSource: LocationSource = null;
      let locationHint: string | undefined;

      if (opts.fixedLocation) {
        // Replay: bierzemy zapisaną pozycję 1:1.
        location = opts.fixedLocation.location;
        locationSource = opts.fixedLocation.locationSource;
        locationHint = opts.fixedLocation.locationHint;
      } else {
        if (opts.useExifLocation) {
          const withGeo = opts.images.find((i) => i.exifLocation);
          if (withGeo?.exifLocation) {
            location = withGeo.exifLocation;
            locationSource = "exif";
          }
        }
        if (!location && opts.useDeviceLocation) {
          try {
            location = await getCurrentLocation();
            locationSource = "device";
          } catch {
            location = null; // brak zgody/błąd — skanujemy dalej bez lokalizacji
          }
        }
        // „Miasto, Kraj" z GPS → pewny kontekst dla modelu przy tłumaczeniu (gdzie jest lokal).
        locationHint = location ? await reverseGeocode(location) : undefined;
      }

      // Tryb testowy: zapisz migawkę tego, co właśnie idzie do serwera (zdjęcia +
      // ustawienia + dokładna pozycja). Id migawki łączymy później ze skanem, żeby
      // eksport dołączył też WYNIK. Nie blokuje skanu krytycznie (przy błędzie → null).
      let capture: ScanCapture | null = null;
      if (opts.recordCapture !== false) {
        // REPLAY z istniejącej migawki → REUŻYJ jej (nowy scanId podepniemy niżej przez addCaptureRun),
        // żeby ponowne wyszukiwanie z tej samej próbki NIE tworzyło nowej migawki (mylące).
        if (replayCaptureIdRef.current) {
          const caps = await listCaptures().catch(() => [] as ScanCapture[]);
          capture = caps.find((c) => c.id === replayCaptureIdRef.current) ?? null;
        }
        if (!capture) {
          capture = await saveCapture({
            images: opts.images,
            restaurantHint: opts.hint.trim() || undefined,
            locationHint,
            location,
            locationSource,
            useExifLocation: opts.useExifLocation,
            useDeviceLocation: opts.useDeviceLocation,
          }).catch(() => null);
        }
        listCaptures().then(setCaptures).catch(() => {});
      }

      // Strony NAJSTARSZE→NAJNOWSZE (EXIF DateTimeOriginal) — user zwykle fotografuje menu po kolei,
      // co daje sensowniejszą strukturę i ciągłość grup. Brak czasu → zachowaj kolejność dodania.
      const ordered = opts.images
        .map((im, i) => ({ im, i }))
        .sort((a, b) => (a.im.takenAt ?? Infinity) - (b.im.takenAt ?? Infinity) || a.i - b.i)
        .map((x) => x.im);
      // (Architektura B: podziałem na partie modelu zajmuje się SERWER w /scan/run — po rozmiarze.
      // Apka tylko wysyła zdjęcia pojedynczo w kolejności `ordered`.)

      let merged: Menu | null = null;
      let scanId: string | null = null;
      setScanFromCache(false);

      // PREFETCH zdjęć poglądowych NA ŻYWO: gdy model wypisze pozycję, od razu dociągamy dla niej
      // tanie zdjęcie (Serper) — gotowe, zanim skan się skończy; potem reużyte (bez ponownego szukania).
      setScanItems([]);
      setScanFoundName(null);
      const onScanItem = (stub: ScanItemStub) => {
        // Nazwa do mini-listy (za darmo). Zdjęcia poglądowe dociąga POMPA, gdy rolling da photo_query
        // (struktura strumieniuje nazwy bez photo_query — nie szukamy po surowej nazwie).
        setScanItems((prev) => [
          ...prev,
          { original: stub.original, translated: stub.translated, branded: stub.branded, price: stub.price, currency: stub.currency, description: stub.description },
        ]);
        // Rolling enrich: danie do kolejki; flush co ~8, ALE dopiero gdy znamy kuchnię ze struktury
        // (stabilny klucz cache). Do tego czasu kolejka rośnie — onMeta ją opróżni, gdy kuchnia dojdzie.
        enrichQueue.push(stub);
        if (cuisineReady && enrichQueue.length >= ENRICH_FLUSH) flushEnrich();
      };
      // (martwe w dwufazowym — server structureOnly nie emituje enrich-item; zostaje dla zgodności sygnatury)
      const onEnrichItem = (stub: ScanItemStub) => {
        setScanItems((prev) => prev.map((x) => (x.original === stub.original
          ? { ...x, translated: stub.translated || x.translated, description: stub.description || x.description }
          : x)));
      };
      // ENRICH STRUMIENIOWY (rolling po ~8 dań): dania spływają ze STRUKTURY (onScanItem) → kolejka →
      // flush paczkami do /enrich. Startuje WCZEŚNIE (po ustaleniu kuchni z onMeta/peeku) i nakłada się
      // na trwającą strukturę, ale robi ~N/8 wywołań zamiast jednego na danie. Patch W MIEJSCU po nazwie.
      // Spójność klucza cache: ta sama kuchnia (scanCuisine) + locationHint + menu_description (ze strumienia)
      // co finałowy enrich → finał trafia w cache, nic się nie marnuje.
      const enrichJobs: Promise<void>[] = [];
      const enrichedAcc = new Map<string, MenuItem>(); // original → wzbogacona pozycja (wyniki rollingu)
      // Usage enrichu kumulujemy LOKALNIE — rolling leci w trakcie struktury, gdy scanId jeszcze NIE
      // istnieje (powstaje przy scaleniu partii). Doliczymy do skanu raz, w finale (#3: fix kosztu).
      let enrichUsage: Usage = ZERO_USAGE;
      let scanCuisine = pickPeekCuisine() || ""; // kuchnia do enrichu — peek; nadpisze ją struktura (onMeta)
      // Kuchnia ze STRUKTURY (onMeta) jest DETERMINISTYCZNA (przy re-skanie struktura z cache → ta sama
      // kuchnia). Peek to osobne, niestabilne wywołanie. Dla STABILNEGO klucza cache enrichu (kuchnia jest
      // jego częścią) NIE flushujemy enrichu, póki nie znamy kuchni ze struktury — inaczej wczesne partie
      // szły z pustą/peek kuchnią, klucz różnił się co skan i cache nie trafiał. Patrz [[menubutbetter-cache]].
      let cuisineReady = false;
      let scanReadName = ""; // ostatnia nazwa lokalu ze streamu (fallback, gdy venue_match nie trafi)
      let nearbyCands: RestaurantInfo[] = []; // kandydaci „w pobliżu" (do vision: venue_match)
      // POGLĄDOWE W TRAKCIE: gdy rolling da photo_query, od razu dociągamy tanie poglądowe (Serper/Wiki),
      // żeby zdjęcia pojawiały się WCZEŚNIE (jak dawny prefetch), a nie w finale. attachPhotosByName jest
      // no-op gdy pozycji jeszcze nie ma w menu (w trakcie struktury) → trzymamy w previewAcc i dokładamy
      // przy structureReady/compose. previewStartedRef → ★ z lokalu dopiero po poglądowych.
      const previewAcc = new Map<string, DishPhotoLite[]>();
      const pfQueue: { original: string; photoQuery: string }[] = [];
      let pfActive = 0;
      let pfEnqueued = 0;
      const pumpPreview = () => {
        while (pfActive < 4 && pfQueue.length > 0) {
          const job = pfQueue.shift()!;
          pfActive++;
          void (async () => {
            try {
              const { photos } = await fetchDishPhotos(job.original, undefined, {
                representativeOnly: true, num: REPR_PER_DISH, photoQuery: job.photoQuery, cuisine: scanCuisine, verifyModel: opts.models.verify, takeAll: costPrefs.takeAllPhotos,
              });
              if (photos.length > 0) {
                const cached = await cachePhotos(photos);
                previewAcc.set(job.original, cached);
                previewStartedRef.current = true;
                // Mini-karta na ekranie skanu: pokaż miniaturę OD RAZU (w fazie struktury menu jest null,
                // więc setMenu niżej to no-op — bez tego zdjęcia widać dopiero po „Otwórz menu").
                setScanItems((prev) => prev.map((x) => (x.original === job.original && !x.photo ? { ...x, photo: cached[0]?.url } : x)));
                setMenu((prev) => (prev ? attachPhotosByName(prev, job.original, cached) : prev));
                maybeUpgradeVenue();
              }
            } catch {
              /* ciche — brak poglądowego dla tego dania */
            } finally {
              pfActive--;
              pumpPreview();
              // Gdy pompa skończyła (brak aktywnych i kolejka pusta) → zapisz menu z dociągniętymi
              // poglądowymi (inaczej te dodane PO compose nie trafiłyby do zapisanego skanu).
              if (pfActive === 0 && pfQueue.length === 0 && scanIdRef.current) {
                setMenu((prev) => { if (prev && scanIdRef.current) void updateScanMenu(scanIdRef.current, prev); return prev; });
              }
            }
          })();
        }
      };
      const enrichQueue: ScanItemStub[] = [];
      const ENRICH_FLUSH = 8;
      const stubToItem = (s: ScanItemStub): MenuItem => ({
        original: s.original, translated: s.original, source_text: s.original,
        menu_description: s.description || "", description: "",
        ingredients: [], allergens: [], category: "other",
        dietary: { vegetarian: false, vegan: false, gluten_free: false }, spice_level: 0,
        price: s.price, currency: s.currency,
      });
      const flushEnrich = () => {
        if (enrichQueue.length === 0) return;
        const batch = enrichQueue.splice(0, enrichQueue.length);
        const partial: Menu = {
          restaurant_name: null, restaurant_address: null, restaurant_language: "",
          cuisine: scanCuisine,
          sections: [{ name: "", name_translated: "", items: batch.map(stubToItem) }],
          notes: [],
        };
        enrichJobs.push((async () => {
          try {
            const onEnrich = (stub: ScanItemStub) => {
              setMenu((prev) => (prev ? patchEnrichByName(prev, stub) : prev));
              setScanItems((prev) => prev.map((x) => (x.original === stub.original ? { ...x, translated: stub.translated || x.translated, description: stub.description || x.description } : x)));
            };
            const { menu: enriched, usage } = await enrichMenuOnServer(
              partial,
              { targetLang: opts.targetLang, locationHint, cuisineHint: scanCuisine || pickPeekCuisine(), model: opts.models.scan, enrichModel: opts.models.enrich },
              undefined,
              onEnrich,
            );
            // Zbierz wyniki LOKALNIE — rolling w trakcie struktury nie mógł zapatchować menu (pozycji
            // jeszcze w nim nie było); po wszystkich partiach złożymy menu z tego, bez redundantnego finału.
            enriched.sections.forEach((s) => s.items.forEach((it) => {
              enrichedAcc.set(it.original, { ...it, enriched: true });
              // od razu kolejkuj tanie poglądowe (limit z „Kosztów"); apply pojawi się gdy pozycja jest w menu
              if (costPrefs.autoPhotos && it.photo_query && (costPrefs.autoLimit <= 0 || pfEnqueued < costPrefs.autoLimit)) {
                pfEnqueued++;
                pfQueue.push({ original: it.original, photoQuery: it.photo_query });
                pumpPreview();
              }
            }));
            setMenu((prev) => (prev ? applyEnrich(prev, enriched) : prev));
            enrichUsage = addUsage(enrichUsage, usage); // #3: kumuluj (scanId może jeszcze nie istnieć)
          } catch {
            // paczka enrich padła — pozycje zostają z oryginałem; finałowy enrich i tak dopina
          }
        })());
      };

      // === ARCHITEKTURA B: sesja — zdjęcia wysyłamy POJEDYNCZO (odporne, retry per zdjęcie, pasek postępu),
      // serwer buforuje, tnie PO ROZMIARZE na partie modelu i streamuje strukturę (onScanItem → rolling). ===
      setScanPhase({ label: "Wysyłam zdjęcia…" });
      // Lokale „w pobliżu" (mały promień) liczymy RÓWNOLEGLE z uploadem — vision dostanie ich nazwy+kuchnię
      // i może wskazać lokal (venue_match). Wymaga GPS; ciche niepowodzenie = brak listy (działa jak dotąd).
      const nearbyPromise: Promise<RestaurantInfo[]> = location
        ? fetchRestaurant({ forceNearby: true, location, targetLang: opts.targetLang, radius: VENUE_MATCH_RADIUS })
            .then((res) => res.candidates ?? [])
            .catch(() => [])
        : Promise.resolve([]);
      const sessionId = await scanStart({
        targetLang: opts.targetLang,
        restaurantHint: opts.hint.trim() || undefined,
        locationHint,
        cuisineHint: pickPeekCuisine(),
        model: opts.models.scan,
        enrichModel: opts.models.enrich,
      });
      // Upload SEKWENCYJNY (jedno po drugim, NIE równolegle) — pasek = wysłane/total. `ordered` jest już
      // posortowane po dacie (takenAt), indeks `i` też idzie po dacie; dodatkowo wysyłamy takenAt, więc
      // serwer ułoży strony po dacie. Na każde zdjęcie: 1 próba + 1 AUTO-retry; jeśli dalej pada → PYTAMY
      // usera (wysłano X z Y, możliwy problem z siecią) i ponawiamy aż się uda albo user przerwie skan.
      // Żadne zdjęcie nie ginie po cichu.
      setScanProgress({ done: 0, total: ordered.length });
      const askRetryUpload = (sentOk: number): Promise<boolean> =>
        new Promise((resolve) => {
          Alert.alert(
            "Problem z wysłaniem zdjęcia",
            `Udało się wysłać ${sentOk} z ${ordered.length} zdjęć — możliwy problem z siecią. Ponowić?`,
            [
              { text: "Przerwij skan", style: "cancel", onPress: () => resolve(false) },
              { text: "Ponów", onPress: () => resolve(true) },
            ],
            { cancelable: false },
          );
        });
      for (let i = 0; i < ordered.length; i++) {
        const img = { base64: ordered[i]!.base64, mediaType: ordered[i]!.mediaType, takenAt: ordered[i]!.takenAt, srcHash: ordered[i]!.srcHash };
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try { await scanUploadPhoto(sessionId, i, img); ok = true; } catch { /* 1 automatyczny retry */ }
        }
        while (!ok) {
          if (!(await askRetryUpload(i))) throw new Error(`Skan przerwany — wysłano ${i} z ${ordered.length} zdjęć (problem z siecią).`);
          try { await scanUploadPhoto(sessionId, i, img); ok = true; } catch { /* zapyta ponownie */ }
        }
        setScanProgress({ done: i + 1, total: ordered.length });
      }
      // Skan: serwer streamuje strukturę; onScanItem napędza rolling enrich, onMeta daje nazwę/kuchnię (+#2a).
      setScanPhase({ label: "Czytam menu…" });
      nearbyCands = await nearbyPromise; // gotowe po uploadzie — bez opóźniania startu skanu
      const ran = await scanRun(
        sessionId,
        (p) => setScanPhase(scanPhaseLabel(p)),
        onScanItem,
        (m) => {
          if (myGen !== scanGenRef.current) return; // spóźniony meta STAREGO skanu — nie dotykaj bieżącego
          if (m.cuisine && m.cuisine.trim()) {
            scanCuisine = m.cuisine.trim();
            // Kuchnia ze struktury znana → odblokuj rolling enrich i opróżnij to, co czekało.
            if (!cuisineReady) { cuisineReady = true; flushEnrich(); }
          }

          // venue_match (przychodzi PO sparsowaniu struktury): vision wskazało lokal z „w pobliżu". Ma
          // PIERWSZEŃSTWO nad zgadywaniem po nazwie. by='name' → pewny; by='cuisine' → zgadnięty (Tier 0
          // rygorystyczny). Brak dopasowania → fallback po odczytanej nazwie/GPS.
          if (m.venueMatch !== undefined) {
            if (earlyVenueRef.current) return;
            earlyVenueRef.current = true;
            const cand = m.venueMatch ? nearbyCands[m.venueMatch.index] : undefined;
            if (cand) {
              setScanFoundName(cand.name);
              const venue: RestaurantInfo = m.venueMatch!.by === "cuisine"
                ? { ...cand, guessedByLocation: true, nameVerified: false }
                : { ...cand, guessedByLocation: false, nameVerified: true };
              const minimal: Menu = { restaurant_name: cand.name, restaurant_address: cand.address ?? null, restaurant_language: "", cuisine: scanCuisine || pickPeekCuisine() || "", sections: [], notes: [] };
              void lookupRestaurant(minimal, location, scanIdRef.current, opts.targetLang, applyEarlyVenue, { skipUpgrade: true, preResolved: venue });
            } else if (scanReadName || location) {
              const minimal: Menu = { restaurant_name: scanReadName || null, restaurant_address: null, restaurant_language: "", cuisine: scanCuisine || pickPeekCuisine() || "", sections: [], notes: [] };
              void lookupRestaurant(minimal, location, scanIdRef.current, opts.targetLang, applyEarlyVenue, { skipUpgrade: true });
            }
            return;
          }

          // Zdarzenie nazwy (streaming). Z kandydatami CZEKAMY na venue_match (lepszy sygnał) — pokaż samą
          // nazwę. Bez kandydatów (brak GPS) — wczesny lookup po nazwie, jak dotąd.
          if (!m.restaurantName) return;
          setScanFoundName(m.restaurantName);
          scanReadName = m.restaurantName;
          if (nearbyCands.length === 0 && !earlyVenueRef.current) {
            earlyVenueRef.current = true;
            const minimal: Menu = { restaurant_name: m.restaurantName, restaurant_address: null, restaurant_language: "", cuisine: scanCuisine || pickPeekCuisine() || "", sections: [], notes: [] };
            void lookupRestaurant(minimal, location, scanIdRef.current, opts.targetLang, applyEarlyVenue, { skipUpgrade: true });
          }
        },
        nearbyCands.map((c) => ({ name: c.name, cuisine: c.cuisine ?? null })),
      );
      merged = ran.menu;
      if (ran.cached) setScanFromCache(true); // cała struktura z cache → „bez kosztu modelu"
      if (opts.hint.trim()) merged.restaurant_name = opts.hint.trim(); // nazwa od usera ma pierwszeństwo
      {
        const saved = await saveScan({
          menu: merged,
          targetLang: opts.targetLang,
          model: opts.models.scan,
          models: opts.models,
          location,
          locationSource,
          useExifLocation: opts.useExifLocation,
          useDeviceLocation: opts.useDeviceLocation,
          usage: ran.usage,
          sessionId: sessionIdRef.current,
        });
        scanId = saved.id;
        scanIdRef.current = saved.id;
        activeCostScanRef.current = saved.id; // od teraz live koszt sesji utrwalaj do TEGO skanu
        setFreshScanId(saved.id);
        setScans(await listScans());
      }

      // === FAZA A GOTOWA: struktura wszystkich stron złożona i ZAMROŻONA (kolejność/grupy się nie zmienią) ===
      setScanProgress(null);
      const structureMenu = merged as Menu;
      // Dołącz poglądowe dociągnięte JUŻ w trakcie struktury (rolling dał photo_query, pompa pobrała,
      // ale apply był no-op bo pozycji nie było w menu) — teraz pozycje są, więc je wstaw.
      const withPreviews = (m: Menu): Menu => {
        if (previewAcc.size === 0) return m;
        let out = m;
        for (const [orig, ph] of previewAcc) out = attachPhotosByName(out, orig, ph);
        return out;
      };
      setMenu(withPreviews(structureMenu));
      if (scanId) void updateScanMenu(scanId, structureMenu);
      setStructureReady(true); // struktura kompletna i zamrożona
      setBrowseEarly(true); // AUTO: skoro można już przejść do listy, przechodzimy — bez przycisku; enrich
      //                       (tłumaczenia/opisy/zdjęcia) dochodzi w miejscu już w widoku menu.
      structureFrozenRef.current = true; // #2a: od teraz wolno robić upgrade ★ (struktura niezmienna)
      structureMenuRef.current = structureMenu;
      scanIdRef.current = scanId!;

      // Powiąż migawkę z zapisanym skanem → eksport dołączy WYNIK (do analizy „co źle").
      if (capture && scanId) void addCaptureRun(capture.id, scanId).catch(() => {});

      // Zapisz ZDJĘCIA ŹRÓDŁOWE (te, z których powstało menu) do podglądu w historii.
      if (scanId) {
        try {
          const sp = persistScanImages(scanId, ordered);
          if (sp.length > 0) void setScanSourcePhotos(scanId, sp);
        } catch {
          /* zapis zdjęć źródłowych best-effort — nie blokuje skanu */
        }
      }

      // Lokal na ZAMROŻONEJ strukturze. #2a: kartę mógł już pokazać wczesny lookup (onMeta) — NIE resetujemy
      // freshRestaurant. Kontekst karty (wybór/szukanie) z prawdziwym scanId + zamrożonym menu.
      setRestaurantCtx({
        menu: structureMenu,
        location,
        scanId: scanId!,
        lang: opts.targetLang,
        apply: applyEarlyVenue,
        applyMenu: setMenu,
        current: freshVenueRef.current,
        candidates: [],
      });
      if (freshVenueRef.current) {
        // wczesny lookup już znalazł lokal → domknij (zapis; ★ przez maybeUpgradeVenue gdy ruszą poglądowe)
        void finalizeVenue(structureMenu, scanId!, freshVenueRef.current);
      } else if (!earlyVenueRef.current && structureMenu.restaurant_name) {
        // onMeta nie zgłosił nazwy w trakcie, ale jest w strukturze → read-only lookup (skipUpgrade),
        // a ★ z lokalu pójdzie przez applyEarlyVenue→finalizeVenue→maybeUpgradeVenue (po poglądowych).
        void lookupRestaurant(structureMenu, location, scanId!, opts.targetLang, applyEarlyVenue, { applyMenu: setMenu, skipUpgrade: true });
      }
      // (jeśli earlyVenueRef ustawiony, ale wynik jeszcze nie doszedł → applyEarlyVenue domknie sam, gdy wróci)

      // === FAZA B: enrich leci ROLLING (po ~8 dań, ruszył już w trakcie struktury). Tu domykamy ostatnią
      // paczkę, czekamy na rolling, robimy FINAŁOWY enrich na KOMPLETNEJ strukturze (tłumaczy SEKCJE,
      // których rolling nie ruszał, i dopina pominięte) — dania z rollingu = trafienia cache → szybko. ===
      void (async () => {
        setScanPhase({ label: "Tłumaczę grupy…" });
        // #2: NAJPIERW grupy + notatki (szkielet bez dań — szybko). Awaitujemy (mało elementów), żeby
        // tłumaczenia sekcji weszły do finalMenu/zapisu; sekcje są cache'owane więc to tanie.
        const sectTrans = new Map<string, string>();
        const noteTrans = new Map<string, string>();
        try {
          const skeleton: Menu = { ...structureMenu, sections: structureMenu.sections.map((s) => ({ ...s, items: [] })) };
          const { menu: skel, usage: skelUsage } = await enrichMenuOnServer(
            skeleton,
            { targetLang: opts.targetLang, locationHint, cuisineHint: scanCuisine || pickPeekCuisine(), model: opts.models.scan, enrichModel: opts.models.enrich },
          );
          skel.sections.forEach((s) => sectTrans.set(s.name, s.name_translated));
          (skel.notes ?? []).forEach((n) => noteTrans.set(n.text, n.text_translated));
          enrichUsage = addUsage(enrichUsage, skelUsage);
          setMenu((prev) => (prev ? applyEnrich(prev, skel) : prev)); // pokaż przetłumaczone grupy od razu
        } catch {
          /* tłumaczenie grup padło — zostaną oryginalne nazwy sekcji */
        }
        setScanPhase({ label: "Tłumaczę i opisuję dania…" });
        // Backstop: gdyby onMeta nie dało kuchni, weź ją z gotowej struktury (deterministyczna) — żeby
        // ostatnia (i ewentualnie cała) partia poszła ze STABILNĄ kuchnią, nie z peek.
        if (!cuisineReady && merged.cuisine) { scanCuisine = merged.cuisine; cuisineReady = true; }
        flushEnrich(); // domknij ostatnią paczkę (<8 dań)
        try {
          await Promise.all(enrichJobs);
        } catch {
          /* część paczek mogła paść — finalizujemy z tym, co jest */
        }
        // Składamy menu z wyników ROLLINGU (enrichedAcc) + tłumaczeń sekcji — BEZ redundantnego finałowego
        // enrichu (to on powodował „32/32 a wciąż mieli": re-streamował to samo z cache i blokował „done").
        const compose = (base: Menu): Menu => ({
          ...base,
          sections: base.sections.map((s) => ({
            ...s,
            name_translated: sectTrans.get(s.name) ?? s.name_translated,
            items: s.items.map((it) => {
              const e = enrichedAcc.get(it.original);
              // zachowaj zdjęcia z żywego menu (★/poglądowe); inaczej dołóż poglądowe z pompy (previewAcc).
              const photos = it.photos && it.photos.length > 0 ? it.photos : previewAcc.get(it.original) ?? e?.photos;
              return e ? { ...e, photos, enriched: true } : photos ? { ...it, photos } : it;
            }),
          })),
          notes: (base.notes ?? []).map((n) => ({ ...n, text_translated: noteTrans.get(n.text) ?? n.text_translated })),
        });
        const finalMenu = compose(structureMenu); // jawnie (z poglądowymi z pompy)
        setMenu((prev) => (prev ? compose(prev) : finalMenu)); // na żywym menu — zachowaj dociągnięte zdjęcia
        if (scanId) void addScanUsage(scanId, enrichUsage); // #3: dolicz CAŁY enrich raz
        if (scanId) void updateScanMenu(scanId, finalMenu);
        setScans(await listScans());
        // (poglądowe lecą POMPĄ w trakcie rollingu — nie wołamy fillDishPhotos tutaj)
        if (costPrefs.autoDescriptions) void fillDescriptions(finalMenu, scanId!, opts.targetLang, setMenu);
        // Poglądowe ruszyły → teraz wolno podmieniać ★ z lokalu (jeśli lokal już znaleziony; inaczej
        // zrobi to finalizeVenue gdy lookup wróci). Dzięki temu tanie poglądowe pojawiają się PIERWSZE.
        previewStartedRef.current = true;
        maybeUpgradeVenue();
        setScanPhase(null);
        setScanItems([]);
        setStatus("done");
      })();
      // (Architektura B: padłe partie nie istnieją po stronie apki — serwer scala wewnętrznie; odporność
      // jest na poziomie POJEDYNCZEGO uploadu zdjęcia, retry w scanUploadPhoto.)
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { stack: e instanceof Error ? e.stack : undefined, label: "scan", context: { images: opts.images.length, model: opts.models.scan } });
      setError(friendlyMessage(e instanceof Error ? e.message : undefined));
      setStatus("error");
      setScanProgress(null);
      setScanPhase(null);
      setScanItems([]);
    }
  }

  // Patch pozycji po ORYGINALNEJ nazwie (Faza B, enrich w miejscu): tłumaczenie + opis + photo_query.
  // Struktura zamrożona, więc dokładamy tylko pola tekstowe — bez ruszania kolejności/grup.
  function patchEnrichByName(m: Menu, stub: ScanItemStub): Menu {
    let changed = false;
    const sections = m.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (it.original !== stub.original) return it;
        changed = true;
        return {
          ...it,
          translated: stub.translated || it.translated,
          description: stub.description || it.description,
          photo_query: stub.photoQuery || it.photo_query,
          branded: stub.branded ?? it.branded,
          enriched: true, // pozycja wzbogacona → zdejmij spinner „tłumaczę…"
        };
      }),
    }));
    return changed ? { ...m, sections } : m;
  }

  // Złóż finalne menu: dołóż pełne pola enrich (składniki/alergeny/kategoria/dietetyka/tłum. sekcji) z
  // /enrich do ŻYWEJ struktury — keyowane po NAZWIE (odporne na pozycje dodane w tle przez padłe partie),
  // zachowując już dociągnięte zdjęcia. Pozycje spoza enrichu (np. z padłej partii) zostają nietknięte.
  function applyEnrich(prev: Menu, enriched: Menu): Menu {
    const enrByName = new Map<string, Menu["sections"][number]["items"][number]>();
    enriched.sections.forEach((s) => s.items.forEach((it) => enrByName.set(it.original, it)));
    const sectTrans = new Map<string, string>();
    enriched.sections.forEach((s) => sectTrans.set(s.name, s.name_translated));
    const noteTrans = new Map<string, string>();
    (enriched.notes ?? []).forEach((n) => noteTrans.set(n.text, n.text_translated));
    return {
      ...prev,
      cuisine: enriched.cuisine || prev.cuisine,
      sections: prev.sections.map((s) => ({
        ...s,
        name_translated: sectTrans.get(s.name) ?? s.name_translated,
        items: s.items.map((it) => {
          const e = enrByName.get(it.original);
          if (!e) return it; // pozycja spoza enrichu (np. z padłej partii) — zostaw jak jest
          return { ...e, enriched: true, photos: it.photos && it.photos.length > 0 ? it.photos : e.photos };
        }),
      })),
      notes: (prev.notes ?? []).map((n) => ({ ...n, text_translated: noteTrans.get(n.text) ?? n.text_translated })),
    };
  }

  // Tryb testowy: WCZYTAJ migawkę do ekranu skanu (zdjęcia + podpowiedź + przełączniki
  // lokalizacji) — ale NIE startuj skanu. Dzięki temu możesz najpierw zmienić ustawienia
  // (modele/język w Ustawieniach), a potem sam kliknąć „Przetłumacz menu". Skan pójdzie wtedy
  // wg AKTUALNYCH ustawień (porównania tego samego wejścia różnymi modelami).
  async function replayCapture(c: ScanCapture) {
    const imgs: PreparedImage[] = [];
    for (const im of c.images) {
      const base64 = await captureImageBase64(im);
      if (!base64) continue;
      imgs.push({
        uri: resolveCaptureUri(im.path) ?? im.path,
        base64,
        mediaType: "image/jpeg",
        exifLocation: im.exifLocation,
        srcHash: im.srcHash, // stabilny hash oryginału z migawki → cache struktury trafia jak na świeżym skanie
      });
    }
    if (imgs.length === 0) {
      Alert.alert("Brak zdjęć", "Pliki tej migawki nie są już dostępne na urządzeniu.");
      return;
    }
    // Przełącz na ekran skanu i przygotuj go w trybie wyboru (resetScan → idle).
    setShowCaptures(false);
    setShowDiag(false);
    setShowSettings(false);
    setOpenScan(null);
    setTab("scan");
    resetScan();
    replayCaptureIdRef.current = c.id; // to REPLAY tej migawki → kolejny skan podepnie się do niej (bez duplikatu)
    // Wstaw dane migawki do formularza skanu (bez startu — czekamy na klik użytkownika).
    setImages(imgs);
    setHint(c.restaurantHint ?? "");
    setHintManual(!!(c.restaurantHint && c.restaurantHint.trim())); // lokal z migawki traktuj jak ustalony
    setUseExifLocation(c.useExifLocation);
    setUseDeviceLocation(c.useDeviceLocation);
    // Wymuś lokalizację z migawki przy ponownym skanie (eksperyment 1:1 na starej próbce).
    setReplayLocation({ location: c.location, locationSource: c.locationSource, locationHint: c.locationHint });
  }

  function resetScan() {
    replayCaptureIdRef.current = null; // ręczny „nowy skan" → to nie replay (świeża migawka)
    newSession(); // nowa SESJA usera (od „nowy skan" do „nowy skan") — wspólny tag wszystkich ops
    setImages([]);
    setReplayLocation(null);
    setHint("");
    setHintManual(false);
    setMenu(null);
    setError(null);
    setStatus("idle");
    setFreshRestaurant(null);
    setFreshScanId(null);
    setRestaurantCtx(null);
    setBrowseEarly(false);
    setStructureReady(false);
    setShowVenueSearch(false);
    setPeekByUri({});
    setPeekInfo(null);
    setPeekingUris([]);
  }

  async function lookupRestaurant(
    m: Menu,
    location: GeoPoint | null,
    scanId: string | null,
    lang: string,
    apply: (r: RestaurantInfo | null) => void,
    opts?: { forceNearby?: boolean; skipUpgrade?: boolean; applyMenu?: (u: (prev: Menu | null) => Menu | null) => void; preResolved?: RestaurantInfo },
  ) {
    const forceNearby = opts?.forceNearby ?? false;
    const applyMenu = opts?.applyMenu ?? restaurantCtx?.applyMenu ?? setMenu;
    const prevVenue = restaurantCtx?.current ?? null;
    // forceNearby wymaga GPS; zwykłe wyszukiwanie — nazwy ALBO GPS (fallback). preResolved (z venue_match)
    // omija to — lokal już znamy.
    if (!opts?.preResolved && (forceNearby ? !location : !m.restaurant_name && !location)) return;
    // Zapamiętaj kontekst karty (do „wybierz / szukaj w pobliżu / usuń").
    setRestaurantCtx({ menu: m, location, scanId, lang, apply, applyMenu, current: prevVenue, candidates: [] });
    setRestaurantLoading(true);
    try {
      // preResolved: lokal wskazany przez vision (venue_match) — używamy wprost, bez zapytania do Places.
      const { restaurant: r, candidates } = opts?.preResolved
        ? { restaurant: opts.preResolved, candidates: [] as RestaurantInfo[] }
        : await fetchRestaurant({
            name: forceNearby ? undefined : (m.restaurant_name ?? undefined),
            address: m.restaurant_address ?? undefined,
            cuisine: m.cuisine,
            location,
            targetLang: lang,
          });
      apply(r); // pokaż od razu (online, przez proxy)
      if (!r) {
        if (forceNearby) Alert.alert("Brak wyników", "Nie znalazłem innej restauracji w pobliżu.");
        return;
      }
      // Zgadnięto po lokalizacji i jest >1 kandydat — pozwól wybrać właściwy.
      if (r.guessedByLocation && candidates.length > 1) {
        setRestaurantCtx((prev) => (prev ? { ...prev, candidates } : prev));
      }
      if (scanId) {
        await updateScanRestaurant(scanId, r);
        setScans(await listScans());
      }
      // Pobierz zdjęcia lokalu na dysk → offline; potem podmień na lokalne i zapisz.
      const cached = await cacheRestaurantPhotos(r);
      apply(cached);
      setRestaurantCtx((prev) => (prev ? { ...prev, current: cached } : prev));
      if (scanId) {
        await updateScanRestaurant(scanId, cached);
        setScans(await listScans());
      }
      // #2a: read-only (skipUpgrade) — karta lokalu W TRAKCIE struktury, BEZ mutacji menu (★ zdjęcia
      // z lokalu) i bez wymogu scanId. Podmiana zdjęć z lokalu (upgradeVenuePhotos) idzie dopiero na
      // ZAMROŻONEJ strukturze (finalizeVenue), żeby nie ruszać rosnącego menu.
      if (!opts?.skipUpgrade) {
        const baseForUpgrade = await rebaseVenue(m, scanId, applyMenu, prevVenue, r);
        if (costPrefs.autoVenuePhotos) void upgradeVenuePhotos(baseForUpgrade, scanId, cached, applyMenu);
      }
    } catch {
      // ciche niepowodzenie — karta lokalu po prostu się nie pokaże
    } finally {
      setRestaurantLoading(false);
    }
  }

  // #2a: domknięcie lokalu na ZAMROŻONEJ strukturze — zapis do skanu + podmiana ★ zdjęć z lokalu
  // (upgradeVenuePhotos jest funkcyjny → komponuje się z enrichem). Wołane gdy mamy lokal + scanId +
  // zamrożoną strukturę, niezależnie od kolejności (wczesny lookup vs koniec Fazy A). Raz na skan.
  async function finalizeVenue(menu: Menu, scanId: string, venue: RestaurantInfo) {
    if (!venueFinalizedRef.current) {
      venueFinalizedRef.current = true;
      try {
        await updateScanRestaurant(scanId, venue);
        setScans(await listScans());
      } catch {
        /* ciche — karta lokalu i tak jest pokazana */
      }
    }
    // Podmiana ★ z lokalu (wolny krok wizji) DOPIERO gdy ruszyły tanie poglądowe — żeby lista najpierw
    // dostała szybkie zdjęcia, a ★ z lokalu doszły potem (a nie odwrotnie).
    maybeUpgradeVenue();
  }

  // ★ z lokalu — uruchamiane gdy spełnione OBA: ruszyły poglądowe (previewStartedRef) i mamy lokal.
  // Kto ostatni (preview vs lookup) ten triggeruje. Raz na skan. Działa funkcyjnie na żywym menu.
  function maybeUpgradeVenue() {
    if (venueUpgradedRef.current) return;
    if (!previewStartedRef.current) return;
    const venue = freshVenueRef.current;
    const base = structureMenuRef.current;
    const sid = scanIdRef.current;
    if (!venue || !base || !costPrefs.autoVenuePhotos) return;
    venueUpgradedRef.current = true;
    void (async () => {
      try {
        const rebased = await rebaseVenue(base, sid, setMenu, null, venue); // prevVenue null → bez demote
        void upgradeVenuePhotos(rebased, sid, venue, setMenu);
      } catch {
        /* ciche */
      }
    })();
  }

  // (applyEarlyVenue jest teraz LOKALNY w runScan — związany z generacją skanu, by spóźniony lokal
  //  starego skanu nie zatruł bieżącego. Patrz runScan.)

  // User wybiera właściwy lokal z listy kandydatów (gdy zgadywaliśmy po GPS).
  async function pickRestaurant(choice: RestaurantInfo) {
    if (!restaurantCtx) return;
    const { menu, scanId, applyMenu, current: prevVenue } = restaurantCtx;
    const cached = await cacheRestaurantPhotos(choice);
    restaurantCtx.apply(cached);
    setRestaurantCtx((prev) => (prev ? { ...prev, current: cached } : prev));
    if (scanId) {
      await updateScanRestaurant(scanId, cached);
      setScans(await listScans());
    }
    // Wybrano (być może INNY) lokal → zdejmij nieaktualne ★ ze starego i doszukaj z nowego.
    const baseForUpgrade = await rebaseVenue(menu, scanId, applyMenu, prevVenue, choice);
    if (costPrefs.autoVenuePhotos) void upgradeVenuePhotos(baseForUpgrade, scanId, cached, applyMenu);
  }

  // Wyszukanie lokalu PO NAZWIE (na przycisk) — używa nazwy z menu + zapamiętanej/EXIF
  // lokalizacji jako biasu. To główna ścieżka, gdy user sam wpisał/poprawił nazwę.
  function searchByName() {
    if (!restaurantCtx) return;
    const name = restaurantCtx.menu.restaurant_name?.trim();
    if (!name) {
      Alert.alert("Brak nazwy", "Najpierw wpisz nazwę lokalu (✏️ Zmień nazwę menu).");
      return;
    }
    void lookupRestaurant(
      restaurantCtx.menu,
      restaurantCtx.location,
      restaurantCtx.scanId,
      restaurantCtx.lang,
      restaurantCtx.apply,
      { applyMenu: restaurantCtx.applyMenu },
    );
  }


  // Szukanie lokali w pobliżu (GPS + kuchnia). `autoPick` = od razu pokaż najbliższy
  // (gdy nie ma jeszcze dopasowania); inaczej tylko podaj listę kandydatów do wyboru.
  // `radius` w metrach — można zwiększać („szerszy zasięg").
  async function searchNearby(radius = DEFAULT_NEARBY_RADIUS, autoPick = false) {
    if (!restaurantCtx) return;
    if (!restaurantCtx.location) {
      Alert.alert("Brak lokalizacji", "Ten skan nie ma zapisanej pozycji GPS, więc nie wyszukam po okolicy.");
      return;
    }
    setNearbyLoading(true);
    try {
      const { restaurant: best, candidates } = await fetchRestaurant({
        forceNearby: true,
        cuisine: restaurantCtx.menu.cuisine,
        location: restaurantCtx.location,
        targetLang: restaurantCtx.lang,
        radius,
      });
      setRestaurantCtx((prev) => (prev ? { ...prev, candidates, radius } : prev));
      if (candidates.length === 0) {
        Alert.alert("Brak wyników", "Nie znalazłem restauracji w tym zasięgu. Spróbuj „szerszy zasięg”.");
        return;
      }
      // Auto-pokaż najbliższy tylko gdy nic jeszcze nie wybrano (inaczej zostaw obecny,
      // user sam wybierze właściwy z listy — bo najbliższy nie zawsze jest tym właściwym).
      if (autoPick && best) {
        const cached = await cacheRestaurantPhotos(best);
        restaurantCtx.apply(cached);
        if (restaurantCtx.scanId) {
          await updateScanRestaurant(restaurantCtx.scanId, cached);
          setScans(await listScans());
        }
      }
    } catch {
      Alert.alert("Błąd", "Wyszukiwanie w pobliżu nie powiodło się.");
    } finally {
      setNearbyLoading(false);
    }
  }

  // Usuwa dopasowany lokal ze skanu (karta znika; można wyszukać od nowa).
  async function removeRestaurant() {
    if (!restaurantCtx) return;
    const { scanId, menu, applyMenu } = restaurantCtx;
    restaurantCtx.apply(null);
    if (scanId) {
      await clearScanRestaurant(scanId);
      setScans(await listScans());
    }
    // Lokal usunięty → zdejmij potwierdzenie (★) z dotychczasowych zdjęć (nie ma już lokalu,
    // który by je potwierdzał). Zostają jako zwykłe poglądowe; ponowne szukanie ruszy od czysta.
    const demoted = demoteVenuePhotos(menu);
    if (demoted !== menu) {
      applyMenu((prev) => (prev ? demoteVenuePhotos(prev) : demoted)); // funkcyjnie na ŻYWYM menu — nie gubi enrichu z Fazy B
      if (scanId) await updateScanMenu(scanId, demoted);
    }
    setRestaurantCtx((prev) => (prev ? { ...prev, current: null, menu: demoted, candidates: [] } : prev));
  }

  // Karta lokalu albo — gdy brak dopasowania — przyciski wyszukania (po nazwie / w pobliżu).
  function renderRestaurant(r: RestaurantInfo | null) {
    const name = restaurantCtx?.menu.restaurant_name?.trim();
    const hasLoc = !!restaurantCtx?.location;
    if (r || restaurantLoading) {
      return (
        <RestaurantCard
          restaurant={r}
          loading={restaurantLoading}
          onRemove={removeRestaurant}
        />
      );
    }
    // Brak dopasowania → przyciski wyszukania na żądanie.
    if (!name && !hasLoc) return null;
    return (
      <View style={styles.lookupRow}>
        {name ? (
          <Pressable style={styles.searchNearbyBtn} onPress={searchByName}>
            <Text style={styles.searchNearbyText} numberOfLines={1}>
              🔎 Szukaj „{name}"
            </Text>
          </Pressable>
        ) : null}
        {hasLoc ? (
          <Pressable
            style={styles.searchNearbyBtn}
            onPress={() => searchNearby(DEFAULT_NEARBY_RADIUS, true)}
          >
            <Text style={styles.searchNearbyText}>
              {nearbyLoading ? "⏳ Szukam…" : "🔍 Lokal w pobliżu"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  // Zapis nowej nazwy menu (z modala).
  async function doRename(name: string) {
    if (!renameTarget) return;
    const id = renameTarget.id;
    const trimmed = name.trim() || null;
    await renameScan(id, name);
    setScans(await listScans());
    setOpenScan((prev) =>
      prev && prev.id === id
        ? { ...prev, restaurantName: trimmed, menu: { ...prev.menu, restaurant_name: trimmed } }
        : prev,
    );
    setRenameTarget(null);
    // Uwaga: NIE wyszukujemy lokalu automatycznie — user mógł nazwać menu tylko dla
    // własnej wygody. Lokal namierzamy dopiero na przycisk (🔎 Szukaj po nazwie).
  }

  // Pobiera zdjęcia lokalu (Google Places przez proxy + TripAdvisor) na dysk telefonu,
  // żeby karta restauracji działała offline. Google: jedna rozdzielczość (1000 px) na zdjęcie.
  async function cacheRestaurantPhotos(r: RestaurantInfo): Promise<RestaurantInfo> {
    const photoUris = await Promise.all(
      r.photoNames.map((n) => cacheImage(placePhotoUrl(n, 1000))),
    );
    const ta = r.tripAdvisor
      ? {
          ...r.tripAdvisor,
          photos: await Promise.all(
            r.tripAdvisor.photos.map(async (p) => {
              const local = await cacheImage(p.url);
              return local === p.url ? p : { ...p, url: local, remoteUrl: p.remoteUrl ?? p.url };
            }),
          ),
        }
      : r.tripAdvisor;
    return { ...r, photoUris, tripAdvisor: ta };
  }

  function openSaved(scan: SavedScan) {
    setOpenScan(scan);
    // Powrót do SESJI tego skanu — dorabiane ops (opisy/więcej zdjęć/lokal) trafią do tej samej sesji w
    // statystykach. Oglądanie zapisanego skanu NIE tworzy nowej sesji (to robi tylko „nowy skan" i wczytanie
    // sampla). Stary skan bez sesji → nadaj mu TRWAŁY sessionId (zapisz), by kolejne otwarcia go reużywały
    // zamiast rodzić „widmowe" puste sesje.
    if (scan.sessionId) { sessionIdRef.current = scan.sessionId; setScanSession(scan.sessionId); }
    else { const sid = newSession(); void setScanSessionId(scan.id, sid); }
    activeCostScanRef.current = scan.id; // dorabiane ops w historii też utrwalą koszt do TEGO skanu
    setSessionCost(scan.usage?.costUsd ?? 0); // pokaż zapisany koszt sesji od razu; nowe ops dorzuci serwer
    const apply = (r: RestaurantInfo | null) =>
      setOpenScan((prev) => (prev && prev.id === scan.id ? { ...prev, restaurant: r } : prev));
    const applyMenu = makeApplyMenu(scan.id, true);
    // Kontekst karty (do akcji: wybierz / szukaj w pobliżu / usuń) — także gdy lokal już zapisany.
    setRestaurantCtx({
      menu: scan.menu,
      location: scan.location,
      scanId: scan.id,
      lang: scan.targetLang,
      apply,
      applyMenu,
      current: scan.restaurant ?? null,
      candidates: [],
    });
    // Auto-namierzanie TYLKO gdy jest pewna nazwa. Brak nazwy → user kliknie „Lokal w pobliżu".
    if (!scan.restaurant && scan.menu.restaurant_name) {
      lookupRestaurant(scan.menu, scan.location, scan.id, scan.targetLang, apply, { applyMenu });
    }
  }

  async function removeSaved(id: string) {
    const sp = scans.find((s) => s.id === id)?.sourcePhotos;
    if (sp && sp.length > 0) deleteScanImages(sp); // posprzątaj pliki zdjęć źródłowych
    await deleteScan(id);
    setScans(await listScans());
    if (openScan?.id === id) setOpenScan(null);
  }

  // Scala zdjęcia: LEPSZE (świeże) z przodu, dotychczasowe na końcu — bez duplikatów i bez
  // znikania już wyszukanych. Dedup po remoteUrl/url (te same źródła = ten sam plik cache).
  function mergePhotos(fresh: DishPhotoLite[], old: DishPhotoLite[]): DishPhotoLite[] {
    const key = (p: DishPhotoLite) => p.remoteUrl ?? p.url;
    const seen = new Set<string>();
    const dedup = (arr: DishPhotoLite[]) =>
      arr.filter((p) => { const k = key(p); if (seen.has(k)) return false; seen.add(k); return true; });
    // ★ z lokalu = MAX jakość → ZAWSZE z przodu (z dowolnego źródła), żeby nowe wyszukane go nie wyprzedziły.
    // Potem nowe wyszukane (lepsze od poglądowych), na końcu stare poglądowe.
    const venue = dedup([...fresh, ...old].filter((p) => p.fromVenue));
    const freshRest = dedup(fresh.filter((p) => !p.fromVenue));
    const oldRest = dedup(old.filter((p) => !p.fromVenue));
    return [...venue, ...freshRest, ...oldRest];
  }

  function patchItem(m: Menu, si: number, ii: number, patch: Partial<Menu["sections"][0]["items"][0]>): Menu {
    return {
      ...m,
      sections: m.sections.map((s, i) =>
        i !== si
          ? s
          : { ...s, items: s.items.map((it, j) => (j !== ii ? it : { ...it, ...patch })) },
      ),
    };
  }

  // Wstaw zdjęcia poglądowe (prefetch) do pozycji o danej nazwie — z guardem: nie nadpisuj, gdy
  // pozycja już ma zdjęcia (np. lepsze z dotknięcia). Reużywa prefetch, nie szukając ponownie.
  function attachPhotosByName(m: Menu, original: string, photos: DishPhotoLite[]): Menu {
    let changed = false;
    const sections = m.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (changed || it.original !== original || (it.photos && it.photos.length > 0) || it.photosUpgraded) return it;
        changed = true;
        return { ...it, photos };
      }),
    }));
    return changed ? { ...m, sections } : m;
  }

  // Modele OBOWIĄZUJĄCE dla akcji w obrębie danego skanu: ZAMROŻONE z chwili skanu
  // (gdy zapisane), inaczej bieżące ustawienia (starsze skany / świeży skan przed odświeżeniem
  // stanu — wtedy zamrożone == bieżące, więc bezpiecznie). Dzięki temu opisy/zdjęcia w zapisanym
  // menu lecą tym samym modelem co pierwotnie, nawet jeśli zmieniłeś ustawienia globalne.
  function modelsForScan(scanId: string | null): Record<ModelRole, ModelId> {
    // Merge z DEFAULT_MODELS: stare zapisy mogą nie mieć nowych ról (np. enrich) — fallback do domyślnych.
    if (scanId) {
      const s = openScan?.id === scanId ? openScan : scans.find((x) => x.id === scanId);
      if (s?.models) return { ...DEFAULT_MODELS, ...s.models };
    }
    return { ...DEFAULT_MODELS, ...models };
  }

  // Panel „czym zrobiono to menu": data, język i modele per rola (lub starszy zapis bez pełnych).
  function renderScanMeta(scan: SavedScan) {
    const m = scan.models;
    return (
      <View style={styles.metaCard}>
        <Text style={styles.metaTitle}>⚙️ Ustawienia tego menu</Text>
        <Text style={styles.metaRow}>📅 {new Date(scan.createdAt).toLocaleString("pl-PL")}</Text>
        <Text style={styles.metaRow}>🌐 Język: {scan.targetLang}</Text>
        {m ? (
          <>
            <Text style={styles.metaRow}>🔍 Skan menu: {modelLabel(m.scan)}</Text>
            <Text style={styles.metaRow}>📝 Opisy dań: {modelLabel(m.describe)}</Text>
            <Text style={styles.metaRow}>✅ Weryfikacja zdjęć: {modelLabel(m.verify)}</Text>
            <Text style={styles.metaRow}>🏠 Zdjęcia z lokalu: {modelLabel(m.venue)}</Text>
          </>
        ) : (
          <Text style={styles.metaRow}>
            🔍 Model skanu: {modelLabel(scan.model)} · (starszy zapis — bez pełnych ustawień)
          </Text>
        )}
        <Text style={styles.metaHint}>
          Akcje w tym menu (opisy, dociąganie zdjęć) używają tych modeli. „Wyślij ponownie" z migawki
          robi nowy skan wg AKTUALNYCH ustawień.
        </Text>
      </View>
    );
  }

  // WSPÓLNY render detalu menu — TEN SAM kod dla ŚWIEŻEGO skanu i dla otwartego z historii (karta lokalu,
  // menu, lokalizacja, meta, zdjęcia źródłowe, akcje). `menu` osobno (dla świeżego jest LIVE ze stanu).
  // `scanning` → akcje mutujące są disabled (w trakcie odczytu), ale ZAWSZE WIDOCZNE — odblokują się po skanie.
  function renderMenuDetail(args: {
    menu: Menu;
    savedScan: SavedScan | null;
    scanId: string | null;
    restaurant: RestaurantInfo | null;
    restaurantLoading: boolean;
    targetLang: string;
    onItemPress: (si: number, ii: number) => void;
    onSearchMore: (si: number, ii: number) => void;
    scanning: boolean;
    enriching: boolean;
  }) {
    const { menu: m, savedScan: ss, scanId, restaurant: r, scanning } = args;
    const loc = ss?.location ?? null;
    const dis = scanning;
    return (
      <View>
        {r || args.restaurantLoading ? (
          <View style={styles.confirmBox}>
            {renderRestaurant(r)}
            <Pressable style={styles.wrongVenueBtn} onPress={() => setShowVenueSearch(true)}>
              <Text style={styles.wrongVenueText}>🔍 Zły lokal? Znajdź inny →</Text>
            </Pressable>
          </View>
        ) : (
          renderRestaurant(r)
        )}
        <MenuView
          menu={m}
          infoLoading={infoLoading}
          photoLoading={photoLoading}
          onItemPress={args.onItemPress}
          onSearchMorePhotos={args.onSearchMore}
          enriching={args.enriching}
          nameFallback={r?.name}
        />
        {loc ? (
          <Text style={styles.geo}>
            📍 {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
            {ss?.locationSource === "exif" ? "  (ze zdjęcia)" : ss?.locationSource === "device" ? "  (Twoja pozycja przy skanie)" : ""}
          </Text>
        ) : ss ? (
          <Text style={styles.geo}>📍 Bez zapisanej pozycji{ss.useExifLocation === false && ss.useDeviceLocation === false ? " (lokalizacja była wyłączona przy skanie)" : ""}</Text>
        ) : null}
        {ss ? renderScanMeta(ss) : null}
        {ss?.sourcePhotos && ss.sourcePhotos.length > 0 ? (
          <Pressable style={styles.sourcePhotosBtn} onPress={() => setSourceLb({ photos: ss.sourcePhotos!.map((p) => ({ url: resolveCaptureUri(p.path) ?? p.path, source: "menu" })), index: 0 })}>
            <Text style={styles.sourcePhotosText}>📷 Zdjęcia źródłowe menu ({ss.sourcePhotos.length})</Text>
          </Pressable>
        ) : null}
        {scanId ? (
          <>
            <Pressable style={[styles.button, styles.secondary, (dis || appending) && styles.disabled]} disabled={dis || appending} onPress={() => chooseAppendSource(scanId, m, args.targetLang, !!ss)}>
              <Text style={styles.secondaryText}>{appending ? "⏳ Dokładam zdjęcia…" : "➕ Dodaj zdjęcia (uzupełnij menu)"}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondary, dis && styles.disabled]} disabled={dis} onPress={() => refreshScanPhotos(scanId, m, true, r)}>
              <Text style={styles.secondaryText}>{r ? "🔄 Odśwież zdjęcia (doszukaj z lokalu)" : "🔄 Odśwież zdjęcia dań"}</Text>
            </Pressable>
            {ss ? (
              <Pressable style={[styles.button, styles.secondary, dis && styles.disabled]} disabled={dis} onPress={() => setRenameTarget(ss)}>
                <Text style={styles.secondaryText}>✏️ Zmień nazwę menu</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.button, styles.danger, dis && styles.disabled]} disabled={dis} onPress={() => removeSaved(scanId)}>
              <Text style={styles.buttonText}>Usuń z historii</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    );
  }

  async function loadInfo(opts: {
    menu: Menu;
    scanId: string | null;
    si: number;
    ii: number;
    targetLang: string;
    taPhotos?: TripAdvisorPhoto[];
    photoHint?: string;
    location?: string;
    website?: string;
    city?: string;
    taLocationId?: string;
    /** #4: pomiń auto-doszukiwanie LEPSZYCH zdjęć (Faza 2) — robione dopiero na tap „więcej zdjęć". */
    skipPhotos?: boolean;
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void;
  }) {
    const item = opts.menu.sections[opts.si]?.items[opts.ii];
    if (!item) return;
    const { si, ii, scanId } = opts;
    const eff = modelsForScan(scanId); // modele zamrożone z tego menu (opisy + weryfikacja zdjęć)
    const key = `${si}-${ii}`;

    // === FAZA 1: OPIS — natychmiast. Blokuje (spinner) tylko, gdy opisu jeszcze nie ma. ===
    if (!item.extraInfo && !infoLoading.has(key)) {
      setInfoLoading((p) => new Set(p).add(key));
      try {
        const { info, usage } = await fetchDishInfo({
          name: item.original,
          description: item.description,
          restaurant: opts.menu.restaurant_name ?? undefined,
          cuisine: opts.menu.cuisine,
          location: opts.location,
          targetLang: opts.targetLang,
          model: eff.describe,
        });
        // Strażnik nazwy (jak w fillDescriptions): przyklej opis tylko gdy slot wciąż trzyma TO danie.
        opts.applyMenu((prev) => {
          if (!prev) return prev;
          const cur = prev.sections[si]?.items[ii];
          if (!cur || cur.original !== item.original) return prev;
          return patchItem(prev, si, ii, { extraInfo: info });
        });
        if (scanId) {
          await updateScanItem(scanId, si, ii, { extraInfo: info });
          await addScanUsage(scanId, usage);
          setScans(await listScans());
        }
      } catch (e) {
        Alert.alert("Nie udało się pobrać opisu", friendlyMessage(e instanceof Error ? e.message : undefined));
      } finally {
        setInfoLoading((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    }

    // === FAZA 2: LEPSZE ZDJĘCIA — tylko na ŻĄDANIE (tap „więcej zdjęć"), nie automatycznie (#4). ===
    if (!opts.skipPhotos && !item.photosUpgraded && !photoLoading.has(key)) {
      setPhotoLoading((p) => new Set(p).add(key));
      try {
        // Podpisy TripAdvisora (zweryfikowane) → pełne wyszukiwanie (z lokalu/web).
        const matched = matchTaPhotos(item.original, opts.taPhotos);
        const realRes: { photos: DishPhotoLite[]; usage: Usage; debug?: PhotoDebug } =
          matched.length > 0
            ? {
                photos: matched,
                usage: ZERO_USAGE,
                debug: {
                  params: { dish: item.original, source: "TripAdvisor (podpisy zdjęć)" },
                  steps: [
                    { tier: "TripAdvisor podpisy", provider: "TA API", query: item.original, returned: matched.length, passed: matched.length },
                  ],
                  resultCount: matched.length,
                },
              }
            : await fetchDishPhotos(
                item.original,
                opts.photoHint ?? opts.menu.restaurant_name ?? undefined,
                {
                  cuisine: opts.menu.cuisine,
                  website: opts.website,
                  restaurantName: opts.menu.restaurant_name ?? undefined,
                  city: opts.city,
                  taLocationId: opts.taLocationId,
                  branded: item.branded,
                  photoQuery: item.photo_query,
                  photoQueryLocal: item.photo_query_local,
                  verifyModel: eff.verify,
                  takeAll: costPrefs.takeAllPhotos,
                },
              ).catch(() => ({ photos: [] as DishPhotoLite[], usage: ZERO_USAGE, debug: undefined }));
        const real = realRes.photos;
        // LEPSZE zdjęcia z przodu, dotychczasowe (poglądowe) zostają na końcu — nic nie znika.
        // Jak nic nowego → tylko oznacz, by nie szukać znów (zostają obecne).
        const existing = opts.menu.sections[si]?.items[ii]?.photos ?? [];
        const patch =
          real.length > 0
            ? { photos: mergePhotos(await cachePhotos(real), existing), photosUpgraded: true, photoDebug: realRes.debug }
            : { photosUpgraded: true, photoDebug: realRes.debug ?? item.photoDebug };
        opts.applyMenu((prev) => (prev ? patchItem(prev, si, ii, patch) : prev));
        if (scanId) {
          await updateScanItem(scanId, si, ii, patch);
          await addScanUsage(scanId, realRes.usage);
          setScans(await listScans());
        }
      } catch {
        // ciche niepowodzenie zdjęć — opis i tak jest
      } finally {
        setPhotoLoading((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    }
  }

  // Tło po skanie: TANIE zdjęcie poglądowe (Wikimedia/Openverse, zweryfikowane, BEZ Serpera),
  // żeby lista od razu coś miała przy małym koszcie. NIE ustawiamy photosUpgraded — dopiero
  // wejście w danie uruchamia doszukiwanie zdjęć LEPSZEJ jakości (z lokalu/web przez Serper).
  async function fillDishPhotos(
    baseMenu: Menu,
    scanId: string | null,
    _hint: string | undefined,
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void,
  ) {
    const jobs: { si: number; ii: number; name: string; photoQuery?: string }[] = [];
    baseMenu.sections.forEach((sec, si) =>
      sec.items.forEach((it, ii) => {
        if (it && !(it.photos && it.photos.length > 0))
          jobs.push({ si, ii, name: it.original, photoQuery: it.photo_query });
      }),
    );
    if (costPrefs.autoLimit > 0) {
      // autoLimit = ŁĄCZNY limit. Zdjęcia dociągnięte już w trakcie skanu (prefetch) liczą się do
      // niego, więc dobieramy tylko brakujące do limitu (a nie kolejne `autoLimit` ponad prefetch).
      const have = baseMenu.sections.reduce(
        (n, s) => n + s.items.filter((it) => it.photos && it.photos.length > 0).length,
        0,
      );
      jobs.length = Math.min(jobs.length, Math.max(0, costPrefs.autoLimit - have));
    }

    const eff = modelsForScan(scanId); // weryfikacja zdjęć — model zamrożony z tego menu
    const CONCURRENCY = 4;
    let next = 0;
    let totalUsage: Usage = ZERO_USAGE;
    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (!job) break;
        const { photos, usage, debug } = await fetchDishPhotos(job.name, undefined, {
          representativeOnly: true, // tanio: zdjęcie poglądowe (Serper→Wiki) + weryfikacja
          cuisine: baseMenu.cuisine,
          photoQuery: job.photoQuery,
          num: REPR_PER_DISH,
          verifyModel: eff.verify,
          takeAll: costPrefs.takeAllPhotos,
        }).catch(() => ({ photos: [] as DishPhotoLite[], usage: ZERO_USAGE, debug: undefined as PhotoDebug | undefined }));
        totalUsage = addUsage(totalUsage, usage);
        if (photos.length === 0) {
          // Brak zdjęcia, ale zapisz debug, żeby było widać czemu (jakie API, ile zwróciły).
          if (debug) applyMenu((prev) => (prev ? patchItem(prev, job.si, job.ii, { photoDebug: debug }) : prev));
          continue;
        }
        const cached = await cachePhotos(photos); // pobierz na dysk (offline + brak rotacji linków)
        applyMenu((prev) => {
          if (!prev) return prev;
          const cur = prev.sections[job.si]?.items[job.ii];
          // Nie nadpisuj, jeśli user zdążył dostać LEPSZE zdjęcia z dotknięcia.
          if (cur?.photosUpgraded || (cur?.photos && cur.photos.length > 0)) return prev;
          return patchItem(prev, job.si, job.ii, { photos: cached, photoDebug: debug });
        });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    if (scanId) {
      applyMenu((prev) => {
        if (prev) void updateScanMenu(scanId, prev);
        return prev;
      });
      await addScanUsage(scanId, totalUsage);
      setScans(await listScans());
    }
  }

  // Zdejmuje potwierdzenie „★ z tego lokalu" ze zdjęć (zostają jako zwykłe poglądowe).
  // Używane, gdy lokal się ZMIENIŁ/zniknął — stare ★ dotyczyły innego lokalu.
  function demoteVenuePhotos(m: Menu): Menu {
    let touched = false;
    const sections = m.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (!it.photos?.some((p) => p.fromVenue)) return it;
        touched = true;
        return { ...it, photos: it.photos.map((p) => (p.fromVenue ? { ...p, fromVenue: false } : p)) };
      }),
    }));
    return touched ? { ...m, sections } : m;
  }

  // Gdy NOWY lokal różni się od poprzedniego (inne placeId) → zdejmij nieaktualne ★ ze
  // zdjęć i zapisz, żeby `upgradeVenuePhotos` potwierdził je od nowa dla nowego lokalu.
  async function rebaseVenue(
    m: Menu,
    scanId: string | null,
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void,
    prevVenue: RestaurantInfo | null,
    nextVenue: RestaurantInfo,
  ): Promise<Menu> {
    if (!prevVenue?.placeId || prevVenue.placeId === nextVenue.placeId) return m;
    const demoted = demoteVenuePhotos(m);
    if (demoted === m) return m;
    applyMenu((prev) => (prev ? demoteVenuePhotos(prev) : demoted)); // funkcyjnie na ŻYWYM menu — nie gubi enrichu z Fazy B
    if (scanId) await updateScanMenu(scanId, demoted);
    return demoted;
  }

  // Tier 0 — po namierzeniu lokalu: bierze CAŁĄ pulę zdjęć z lokalu (Google Places +
  // TripAdvisor) i JEDNYM przejściem wizji dopasowuje realne potrawy do dań z menu (z
  // odrzuceniem stock/AI). Trafienia → ★ „z lokalu" przy odpowiednich daniach. Dania spoza
  // puli zostają z poglądowymi i dociągają lepsze zdjęcia dopiero przy wejściu (on‑tap).
  async function upgradeVenuePhotos(
    baseMenu: Menu,
    scanId: string | null,
    restaurant: RestaurantInfo,
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void,
  ) {
    const photoNames = restaurant.photoNames ?? [];
    // Do pobrania po stronie serwera potrzebny ZDALNY URL TripAdvisora (nie lokalny plik).
    const taPhotos = (restaurant.tripAdvisor?.photos ?? []).map((p) => ({
      url: p.remoteUrl ?? p.url,
      caption: p.caption,
    }));
    if (photoNames.length === 0 && taPhotos.length === 0) return;

    const dishes: string[] = [];
    baseMenu.sections.forEach((sec) =>
      sec.items.forEach((it) => it?.original && dishes.push(it.original)),
    );
    if (dishes.length === 0) return;

    // Lokal pewny tylko, gdy nazwa potwierdzona i nie zgadnięty po GPS — inaczej serwer każe
    // modelowi rygorystycznie odrzucać zdjęcia niepasujące do kuchni (pula może być z innego lokalu).
    const certain = restaurant.nameVerified !== false && !restaurant.guessedByLocation;
    const { matches, usage } = await fetchVenuePhotos(
      photoNames,
      taPhotos,
      dishes,
      baseMenu.cuisine,
      modelsForScan(scanId).venue, // zdjęcia z lokalu — model zamrożony z tego menu
      certain,
    ).catch(() => ({ matches: [] as VenueMatch[], usage: ZERO_USAGE }));

    // Grupuj po daniu (najpewniejsze pierwsze; serwer już posortował), max 3 zdjęcia/danie.
    const byDish = new Map<string, DishPhotoLite[]>();
    for (const m of matches) {
      const url = m.source === "google" && m.photoName ? placePhotoUrl(m.photoName, 1000) : m.url;
      if (!url) continue;
      const arr = byDish.get(m.dish) ?? [];
      if (arr.length >= 3) continue;
      arr.push({
        url,
        source: m.source,
        attribution: m.source === "tripadvisor" ? "TripAdvisor" : "Google Maps",
        verified: true,
        fromVenue: true,
        fromVenueReason: `Tier 0: zdjęcie z profilu lokalu (${m.source === "tripadvisor" ? "TripAdvisor" : "Google Maps"}) dopasowane wizją do dania (pewność ${m.confidence.toFixed(2)})`,
      });
      byDish.set(m.dish, arr);
    }

    // Indeks danie(oryginalna nazwa) → pozycja w menu.
    const loc = new Map<string, { si: number; ii: number }>();
    baseMenu.sections.forEach((sec, si) =>
      sec.items.forEach((it, ii) => {
        if (it?.original && !loc.has(it.original)) loc.set(it.original, { si, ii });
      }),
    );

    // Pobierz na dysk i przypisz ★ do dań.
    for (const [dish, photos] of byDish) {
      const at = loc.get(dish);
      if (!at) continue;
      const cached = await cachePhotos(photos);
      applyMenu((prev) => {
        if (!prev) return prev;
        const cur = prev.sections[at.si]?.items[at.ii];
        // ★ z lokalu z przodu, dotychczasowe poglądowe zostają na końcu (nie znikają).
        const merged = mergePhotos(cached, cur?.photos ?? []);
        return patchItem(prev, at.si, at.ii, { photos: merged, photosUpgraded: true });
      });
    }

    if (scanId) {
      applyMenu((prev) => {
        if (prev) void updateScanMenu(scanId, prev);
        return prev;
      });
      await addScanUsage(scanId, usage);
      setScans(await listScans());
    }
  }

  // Tło po skanie: generuje PEŁNE opisy dań („więcej info") z automatu, żeby były gotowe
  // ad-hoc po wejściu w danie (bez czekania). Równolegle ze zdjęciami.
  async function fillDescriptions(
    baseMenu: Menu,
    scanId: string | null,
    lang: string,
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void,
  ) {
    const restaurant = baseMenu.restaurant_name ?? undefined;
    const location = baseMenu.restaurant_address ?? undefined;
    const jobs: { si: number; ii: number; name: string; desc: string }[] = [];
    baseMenu.sections.forEach((sec, si) =>
      sec.items.forEach((it, ii) => {
        if (it && !it.extraInfo) jobs.push({ si, ii, name: it.original, desc: it.description });
      }),
    );
    if (costPrefs.autoLimit > 0) jobs.length = Math.min(jobs.length, costPrefs.autoLimit); // limit auto-dociągania

    const CONCURRENCY = 3;
    let next = 0;
    let totalUsage: Usage = ZERO_USAGE;
    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (!job) break;
        const { info, usage } = await fetchDishInfo({
          name: job.name,
          description: job.desc,
          restaurant,
          cuisine: baseMenu.cuisine,
          location,
          targetLang: lang,
          model: modelsForScan(scanId).describe,
        }).catch(() => ({ info: "", usage: ZERO_USAGE }));
        totalUsage = addUsage(totalUsage, usage);
        if (!info) continue;
        applyMenu((prev) => {
          if (!prev) return prev;
          const cur = prev.sections[job.si]?.items[job.ii];
          // STRAŻNIK NAZWY: opis dostajemy po NAZWIE dania, więc przyklejamy go tylko gdy slot (si,ii)
          // wciąż trzyma TO danie. Gdy menu się przesunęło (inny `original`) — NIE przyklejaj cudzego
          // opisu (to powodowało np. opis wody na hamburgerze). Brak nazwy danych = nie ruszaj.
          if (!cur || cur.original !== job.name) return prev;
          if (cur.extraInfo) return prev; // user już dostał z dotknięcia
          return patchItem(prev, job.si, job.ii, { extraInfo: info });
        });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    if (scanId) {
      applyMenu((prev) => {
        if (prev) void updateScanMenu(scanId, prev);
        return prev;
      });
      await addScanUsage(scanId, totalUsage);
      setScans(await listScans());
    }
  }

  // Dokłada nowe zdjęcia do istniejącego menu: ekstrakcja nowych stron + scalenie z
  // deduplikacją (uzupełnia nazwę/braki, dodaje nowe dania, NIE duplikuje istniejących).
  async function appendImages(
    scanId: string,
    baseMenu: Menu,
    scanLang: string,
    isOpen: boolean,
    newImages: PreparedImage[],
  ) {
    if (newImages.length === 0) return;
    setAppending(true);
    try {
      const hint = [baseMenu.restaurant_name, baseMenu.cuisine].filter(Boolean).join(" ") || undefined;
      const { menu: incoming, usage } = await scanMenu(
        {
          images: newImages.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
          targetLang: scanLang,
          restaurantHint: hint,
          model: modelsForScan(scanId).scan, // dokładanie do zapisanego menu — model zamrożony
          enrichModel: modelsForScan(scanId).enrich,
        },
        (p) => setScanPhase(scanPhaseLabel(p)),
      );
      const { menu: merged, addedItems, addedSections } = mergeMenus(baseMenu, incoming);
      await updateScanMenu(scanId, merged);
      await addScanUsage(scanId, usage);

      // Aplikuj scalone menu do właściwego stanu (otwarty zapisany skan albo świeży).
      const applyMenu: (updater: (prev: Menu | null) => Menu | null) => void = isOpen
        ? (updater) =>
            setOpenScan((prev) => {
              if (!prev || prev.id !== scanId) return prev;
              const nm = updater(prev.menu);
              return nm ? { ...prev, menu: nm } : prev;
            })
        : setMenu;
      applyMenu(() => merged);
      setScans(await listScans());

      Alert.alert(
        "Dołączono zdjęcia",
        addedItems > 0
          ? `Dodano ${addedItems} nowych pozycji${addedSections ? ` (w tym ${addedSections} nowych sekcji)` : ""}. Duplikaty pominięto.`
          : "Brak nowych pozycji — wszystko już było w menu (duplikaty pominięto).",
      );

      // Dociągnij dla NOWYCH pozycji (bez photos/opisu): tanie zdjęcia + pełne opisy.
      if (costPrefs.autoPhotos) void fillDishPhotos(merged, scanId, merged.restaurant_name ?? undefined, applyMenu);
      if (costPrefs.autoDescriptions) void fillDescriptions(merged, scanId, scanLang, applyMenu);
    } catch (e) {
      Alert.alert("Nie udało się dodać", friendlyMessage(e instanceof Error ? e.message : undefined));
    } finally {
      setAppending(false);
      setScanPhase(null);
    }
  }

  // Wybór źródła nowych zdjęć (aparat / galeria), potem dołączenie do menu.
  function chooseAppendSource(scanId: string, baseMenu: Menu, scanLang: string, isOpen: boolean) {
    Alert.alert("Dodaj zdjęcia do menu", "Skąd dołączyć kolejne strony / zdjęcia menu?", [
      {
        text: "📷 Aparat",
        onPress: async () => {
          const img = await captureFromCamera();
          if (img) await appendImages(scanId, baseMenu, scanLang, isOpen, [img]);
        },
      },
      {
        text: "🖼 Galeria",
        onPress: async () => {
          const imgs = await pickFromLibrary();
          if (imgs.length) await appendImages(scanId, baseMenu, scanLang, isOpen, imgs);
        },
      },
      { text: "Anuluj", style: "cancel" },
    ]);
  }

  // Zwraca setter menu właściwego stanu (otwarty zapisany skan albo świeży wynik).
  function makeApplyMenu(scanId: string, isOpen: boolean): (u: (prev: Menu | null) => Menu | null) => void {
    return isOpen
      ? (u) =>
          setOpenScan((prev) => {
            if (!prev || prev.id !== scanId) return prev;
            const nm = u(prev.menu);
            return nm ? { ...prev, menu: nm } : prev;
          })
      : setMenu;
  }

  // Odświeża zdjęcia WSZYSTKICH dań: czyści obecne i pobiera+weryfikuje od nowa
  // (przydatne, gdy stare skany mają złe fotki sprzed wzmocnienia weryfikacji).
  function refreshScanPhotos(
    scanId: string,
    baseMenu: Menu,
    isOpen: boolean,
    restaurant?: RestaurantInfo | null,
  ) {
    const venue = restaurant ?? undefined;
    Alert.alert(
      "Odświeżyć zdjęcia dań?",
      venue
        ? "Pobiorę zdjęcia od nowa i doszukam fotek z tego lokalu (★ z jego strony/portali). Zastąpią obecne; koszt jak przy skanie."
        : "Pobiorę i zweryfikuję zdjęcia wszystkich dań od nowa (zastąpią obecne; koszt jak przy skanie).",
      [
        { text: "Anuluj", style: "cancel" },
        {
          text: "Odśwież",
          onPress: async () => {
            const cleared: Menu = {
              ...baseMenu,
              sections: baseMenu.sections.map((s) => ({
                ...s,
                items: s.items.map((it) => ({ ...it, photos: undefined, photosUpgraded: undefined })),
              })),
            };
            const applyMenu = makeApplyMenu(scanId, isOpen);
            applyMenu(() => cleared);
            await updateScanMenu(scanId, cleared);
            setScans(await listScans());
            // Najpierw tanie poglądowe (od razu coś widać), a gdy mamy lokal — doszukaj z niego.
            void fillDishPhotos(cleared, scanId, cleared.restaurant_name ?? undefined, applyMenu);
            if (venue) void upgradeVenuePhotos(cleared, scanId, venue, applyMenu);
          },
        },
      ],
    );
  }

  function photoHintFor(m: Menu, restaurant: RestaurantInfo | null | undefined): string | undefined {
    return [m.restaurant_name, restaurant?.city].filter(Boolean).join(" ") || undefined;
  }

  function locationFor(m: Menu, restaurant: RestaurantInfo | null | undefined): string | undefined {
    return (
      [restaurant?.city, restaurant?.country].filter(Boolean).join(", ") ||
      m.restaurant_address ||
      undefined
    );
  }

  // skipPhotos: rozwinięcie dania (true = tylko opis, BEZ auto-szukania lepszych zdjęć);
  // tap „więcej zdjęć" woła z false → uruchamia Fazę 2 (#4).
  function freshLoadInfo(si: number, ii: number, skipPhotos: boolean) {
    if (menu)
      loadInfo({
        menu,
        scanId: freshScanId,
        si,
        ii,
        targetLang,
        taPhotos: freshRestaurant?.tripAdvisor?.photos,
        photoHint: photoHintFor(menu, freshRestaurant),
        location: locationFor(menu, freshRestaurant),
        website: freshRestaurant?.website ?? undefined,
        city: freshRestaurant?.city ?? undefined,
        taLocationId: freshRestaurant?.tripAdvisor?.locationId ?? undefined,
        skipPhotos,
        applyMenu: setMenu,
      });
  }
  function onFreshItemPress(si: number, ii: number) { freshLoadInfo(si, ii, true); }
  function onFreshSearchMore(si: number, ii: number) { freshLoadInfo(si, ii, false); }

  function detailLoadInfo(si: number, ii: number, skipPhotos: boolean) {
    if (!openScan) return;
    loadInfo({
      menu: openScan.menu,
      scanId: openScan.id,
      si,
      ii,
      targetLang: openScan.targetLang,
      taPhotos: openScan.restaurant?.tripAdvisor?.photos,
      photoHint: photoHintFor(openScan.menu, openScan.restaurant),
      location: locationFor(openScan.menu, openScan.restaurant),
      website: openScan.restaurant?.website ?? undefined,
      city: openScan.restaurant?.city ?? undefined,
      taLocationId: openScan.restaurant?.tripAdvisor?.locationId ?? undefined,
      skipPhotos,
      applyMenu: makeApplyMenu(openScan.id, true),
    });
  }
  function onDetailItemPress(si: number, ii: number) { detailLoadInfo(si, ii, true); }
  function onDetailSearchMore(si: number, ii: number) { detailLoadInfo(si, ii, false); }

  const showingDetail = openScan !== null;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />

        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Text style={styles.brand}>MenuButBetter</Text>
            {showDiag || showCaptures || showPricing || showSettings || showingDetail ? (
              <Pressable
                onPress={() =>
                  showDiag
                    ? setShowDiag(false)
                    : showCaptures
                      ? setShowCaptures(false)
                      : showPricing
                        ? setShowPricing(false)
                        : showSettings
                          ? setShowSettings(false)
                          : setOpenScan(null)
                }
                style={styles.navBtn}
              >
                <Text style={styles.navText}>‹ Wstecz</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setShowSettings(true)} hitSlop={8} style={styles.iconBtn}>
                <Text style={styles.icon}>⚙️</Text>
              </Pressable>
            )}
          </View>
          {!(showDiag || showCaptures || showPricing || showSettings || showingDetail) ? (
            <View style={styles.tabs}>
              <Pressable onPress={() => setTab("scan")}>
                <Text style={[styles.tab, tab === "scan" && styles.tabActive]}>Skan</Text>
              </Pressable>
              <Pressable onPress={() => setTab("history")}>
                <Text style={[styles.tab, tab === "history" && styles.tabActive]}>
                  Historia{scans.length ? ` (${scans.length})` : ""}
                </Text>
              </Pressable>
              {/* „Nowy skan" PRZYKLEJONY w pasku — gdy patrzysz na wynik skanu LUB jesteś w Historii. */}
              {tab === "history" || (tab === "scan" && status === "done" && menu) ? (
                <Pressable onPress={() => { resetScan(); setTab("scan"); }} style={styles.tabsNewScan}>
                  <Text style={styles.navText}>＋ Nowy skan</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {/* #3: cienka linia postępu w STAŁYM nagłówku — zawsze widoczna gdy enrich trwa, treść scrolluje
              pod nią. Znika gdy skan gotowy. */}
          {status === "scanning" && menu && !(showDiag || showCaptures || showPricing || showSettings) ? (() => {
            const menuTotal = menu.sections.reduce((n, s) => n + s.items.length, 0);
            const total = structureReady ? menuTotal : Math.max(menuTotal, scanItems.length);
            const enriched = menu.sections.reduce((n, s) => n + s.items.reduce((m, it) => m + (it.enriched ? 1 : 0), 0), 0);
            const pct = total > 0 ? Math.min(1, enriched / total) : 0;
            return (
              <View style={styles.topProgress}>
                <View style={[styles.topProgressFill, { width: `${Math.round(pct * 100)}%` }]} />
              </View>
            );
          })() : null}
        </View>

        {showDiag ? (
          <DiagnosticsView />
        ) : showPricing ? (
          <PricingView />
        ) : showCaptures ? (
          <CapturesView
            onReplay={replayCapture}
            scans={scans}
            onOpenScan={(scan) => {
              setShowCaptures(false);
              setTab("history");
              openSaved(scan);
            }}
          />
        ) : showSettings ? (
          <SettingsView
            models={models}
            onChangeModel={changeModel}
            onSetModels={setModelsAll}
            targetLang={targetLang}
            onChangeLang={changeLang}
            costPrefs={costPrefs}
            onChangeCostPrefs={changeCostPrefs}
            onOpenDiagnostics={() => setShowDiag(true)}
            onOpenCaptures={() => setShowCaptures(true)}
            onOpenPricing={() => setShowPricing(true)}
            capturesCount={captures.length}
          />
        ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* PODGLĄD ZAPISANEGO MENU */}
          {showingDetail && openScan
            ? renderMenuDetail({
                menu: openScan.menu,
                savedScan: openScan,
                scanId: openScan.id,
                restaurant: openScan.restaurant ?? null,
                restaurantLoading: false,
                targetLang: openScan.targetLang,
                onItemPress: onDetailItemPress,
                onSearchMore: onDetailSearchMore,
                scanning: false,
                enriching: false,
              })
            : null}

          {/* HISTORIA */}
          {!showingDetail && tab === "history" ? (
            <HistoryView
              scans={scans}
              onOpen={openSaved}
              onDelete={removeSaved}
              onRename={setRenameTarget}
            />
          ) : null}

          {/* SKANOWANIE */}
          {!showingDetail && tab === "scan" ? (
            <>
              {status === "idle" ? (
                <View>
                  {/* 1) ZDJĘCIA — główna akcja na górze. Pusto → wyraźny drop-zone. */}
                  {images.length === 0 ? (
                    <View style={styles.dropZone}>
                      <Text style={styles.dropGlyph}>🍽️</Text>
                      <Text style={styles.dropTitle}>Dodaj zdjęcia menu</Text>
                      <Text style={styles.dropSub}>
                        Kilka stron i okładka — połączę je w jedno przetłumaczone menu, które zapiszę w historii.
                      </Text>
                      <View style={styles.addRow}>
                        <Pressable style={styles.addBtn} onPress={openCamera}>
                          <Text style={styles.addBtnText}>📷  Aparat</Text>
                        </Pressable>
                        <Pressable style={styles.addBtn} onPress={addFromLibrary}>
                          <Text style={styles.addBtnText}>🖼️  Galeria</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <>
                      <Text style={styles.label}>
                        Zdjęcia ({images.length}/{MAX_IMAGES})
                      </Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
                        {images.map((img, i) => (
                          <View key={img.uri} style={styles.thumbWrap}>
                            <Image source={{ uri: img.uri }} style={[styles.thumb, peekByUri[img.uri]?.bad && styles.thumbBadDim]} />
                            <Pressable style={styles.thumbRemove} onPress={() => removeImage(i)}>
                              <Text style={styles.thumbRemoveText}>×</Text>
                            </Pressable>
                            <Text style={styles.thumbIndex}>{i + 1}</Text>
                            {peekByUri[img.uri]?.bad ? (
                              <View style={styles.thumbBad}>
                                <Text style={styles.thumbBadText}>⚠️ słaba jakość</Text>
                              </View>
                            ) : peekByUri[img.uri]?.partial ? (
                              <View style={styles.thumbPartial}>
                                <Text style={styles.thumbBadText}>⚠️ niepełne</Text>
                              </View>
                            ) : null}
                          </View>
                        ))}
                      </ScrollView>
                      <View style={styles.addRow}>
                        <Pressable
                          style={[styles.addBtn, images.length >= MAX_IMAGES && styles.disabled]}
                          onPress={openCamera}
                          disabled={images.length >= MAX_IMAGES}
                        >
                          <Text style={styles.addBtnText}>📷  Aparat</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.addBtn, images.length >= MAX_IMAGES && styles.disabled]}
                          onPress={addFromLibrary}
                          disabled={images.length >= MAX_IMAGES}
                        >
                          <Text style={styles.addBtnText}>🖼️  Galeria</Text>
                        </Pressable>
                      </View>
                    </>
                  )}

                  {/* 2) TŁUMACZ — primary, od razu pod zdjęciami. */}
                  <Pressable
                    style={[styles.button, styles.primary, images.length === 0 && styles.disabled]}
                    onPress={doScan}
                    disabled={images.length === 0}
                  >
                    <Text style={styles.buttonText}>
                      {images.length === 0 ? "Najpierw dodaj zdjęcia" : `Przetłumacz menu (${images.length})`}
                    </Text>
                  </Pressable>

                  {error ? <Text style={styles.inlineError}>{error}</Text> : null}

                  {/* 3) OPCJE — zwijane (lokal + lokalizacja), domyślnie schowane. */}
                  <Pressable style={styles.optionsHead} onPress={() => setShowOptions((v) => !v)}>
                    <Text style={styles.optionsHeadText} numberOfLines={1}>
                      ⚙️ Opcje skanu
                      {hint.trim() ? ` · ${hint.trim()}` : ""}
                      {useExifLocation || useDeviceLocation ? " · 📍 lokalizacja wł." : " · 📍 wył."}
                    </Text>
                    <Text style={styles.optionsChevron}>{showOptions ? "▾" : "›"}</Text>
                  </Pressable>
                  {showOptions ? (
                    <View style={styles.optionsBody}>
                      <Text style={styles.label}>Lokal (opcjonalnie)</Text>
                      <TextInput
                        value={hint}
                        onChangeText={(t) => { setHint(t); setHintManual(t.trim().length > 0); }}
                        placeholder="np. Trattoria da Marco, Florencja"
                        placeholderTextColor={colors.muted}
                        style={styles.input}
                      />
                      <Text style={styles.label}>Lokalizacja (pomaga namierzyć lokal)</Text>
                      {replayLocation ? (
                        <Text style={styles.replayLocNote}>
                          🔁 Replay z migawki — lokalizacja wymuszona z próbki: {replayLocation.locationHint || replayLocation.locationSource || "zapisana"} (poniższe przełączniki pominięte)
                        </Text>
                      ) : null}
                      <View style={styles.switchRow}>
                        <View style={styles.switchTextWrap}>
                          <Text style={styles.switchTitle}>📷 Z EXIF zdjęć</Text>
                          <Text style={styles.switchSub}>
                            Współrzędne zaszyte w zdjęciu (jeśli zrobione na miejscu). Działa też później.
                          </Text>
                        </View>
                        <Switch value={useExifLocation} onValueChange={setUseExifLocation} trackColor={{ true: colors.accent }} />
                      </View>
                      <View style={styles.switchRow}>
                        <View style={styles.switchTextWrap}>
                          <Text style={styles.switchTitle}>📍 Moja lokalizacja</Text>
                          <Text style={styles.switchSub}>
                            Pozycja GPS telefonu — pomaga ustalić kraj/miasto, też gdy nie jesteś w lokalu.
                          </Text>
                        </View>
                        <Switch value={useDeviceLocation} onValueChange={setUseDeviceLocation} trackColor={{ true: colors.accent }} />
                      </View>
                    </View>
                  ) : null}

                  {/* 4) Modele + język — szybki link do Ustawień (czytelne etykiety). */}
                  <Pressable style={styles.modelsLink} onPress={() => setShowSettings(true)}>
                    <Text style={styles.modelsLinkText}>
                      ⚙️ Modele:{" "}
                      {new Set(Object.values(models)).size === 1
                        ? modelLabel(models.scan)
                        : `różne (skan ${modelLabel(models.scan)})`}{" "}
                      · Język: {targetLang} — zmień w Ustawieniach
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {status === "scanning" && !browseEarly ? (
                <View style={styles.center}>
                  <ActivityIndicator size="large" color={colors.accent} />
                  {scanProgress ? (
                    <>
                      <Text style={styles.scanning}>
                        Analizuję strony {scanProgress.done}/{scanProgress.total}…
                      </Text>
                      <View style={styles.progressTrack}>
                        <View
                          style={[
                            styles.progressFill,
                            { width: `${Math.round((scanProgress.done / scanProgress.total) * 100)}%` },
                          ]}
                        />
                      </View>
                      <Text style={styles.scanningSub}>Duże menu leci partiami i scala się w jedno.</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.scanning}>Czytam menu z {images.length} zdjęć…</Text>
                      <Text style={styles.scanningSub}>Im więcej stron, tym dłużej — zwykle do minuty.</Text>
                    </>
                  )}
                  {images.length > 0 ? (
                    // Wszystkie strony idą do analizy RÓWNOLEGLE — pokaż je jako scrollowaną listę miniatur;
                    // dotknięcie otwiera pełnoekranowy podgląd (można poczytać menu, czekając na wynik).
                    <View style={styles.scanThumbsWrap}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scanThumbsRow}>
                        {images.map((im, i) => (
                          <Pressable
                            key={im.uri ?? i}
                            onPress={() => setSourceLb({ photos: images.map((x) => ({ url: x.uri, source: "menu", note: peekNote(peekByUri[x.uri]) })), index: i })}
                          >
                            <Image source={{ uri: im.uri }} style={styles.scanThumb} />
                          </Pressable>
                        ))}
                      </ScrollView>
                      <Text style={styles.scanningSub}>Analizuję {images.length} {images.length === 1 ? "zdjęcie" : "zdjęć"} — dotknij, by powiększyć i poczytać.</Text>
                    </View>
                  ) : null}
                  {scanPhase ? (
                    <>
                      <Text style={styles.scanPhase}>{scanPhase.label}</Text>
                      {scanPhase.pct != null ? (
                        <View style={styles.progressTrack}>
                          <View style={[styles.progressFill, { width: `${Math.round(scanPhase.pct * 100)}%` }]} />
                        </View>
                      ) : null}
                    </>
                  ) : null}
                  {scanFoundName && !(freshRestaurant || restaurantLoading) ? (
                    <Text style={styles.scanFoundName}>🏠 Znaleziono lokal: {scanFoundName}</Text>
                  ) : null}
                  {/* #2a: karta lokalu NAD listą dań — zakładamy, że trafiony; „Znajdź inny" → osobny ekran. */}
                  {freshRestaurant || restaurantLoading ? (
                    <View style={styles.scanReadyBox}>
                      <Text style={styles.scanReadyVenueHdr}>📍 Lokal</Text>
                      {renderRestaurant(freshRestaurant)}
                      <Pressable style={styles.wrongVenueBtn} onPress={() => setShowVenueSearch(true)}>
                        <Text style={styles.wrongVenueText}>🔍 Zły lokal? Znajdź inny →</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {scanItems.length > 0 ? (
                    <>
                      <Text style={styles.scanItemsHdr}>
                        📖 {scanItems.length} pozycji · 📝 {scanItems.filter((x) => x.description && x.description.trim()).length} opisów · 🖼 {scanItems.filter((x) => x.photo).length} zdjęć
                      </Text>
                      <ScrollView style={styles.scanItemsBox} contentContainerStyle={{ paddingVertical: 4 }}>
                        {scanItems.map((it, i) => (
                          <View key={i} style={styles.scanCard}>
                            {it.photo ? (
                              <Image source={{ uri: resolveCachedUri(it.photo) ?? it.photo }} style={styles.scanCardThumb} />
                            ) : (
                              <View style={[styles.scanCardThumb, styles.scanItemThumbEmpty]}>
                                {it.branded ? <Text style={{ fontSize: 18 }}>🏷</Text> : <ActivityIndicator size="small" color={colors.muted} />}
                              </View>
                            )}
                            <View style={styles.scanCardBody}>
                              <Text style={styles.scanCardName} numberOfLines={1}>
                                {it.translated || it.original}
                              </Text>
                              {it.description ? (
                                <Text style={styles.scanCardDesc} numberOfLines={2}>
                                  {it.description}
                                </Text>
                              ) : null}
                            </View>
                            {it.price ? (
                              <Text style={styles.scanCardPrice}>
                                {it.price}
                                {it.currency && /^[\d.,\s]+$/.test(it.price) ? " " + it.currency : ""}
                              </Text>
                            ) : null}
                          </View>
                        ))}
                      </ScrollView>
                    </>
                  ) : null}
                </View>
              ) : null}

              {status === "error" ? (
                <View style={styles.center}>
                  <Text style={styles.errorTitle}>Coś poszło nie tak</Text>
                  <Text style={styles.errorMsg}>{error}</Text>
                  <Pressable style={[styles.button, styles.primary]} onPress={() => setStatus("idle")}>
                    <Text style={styles.buttonText}>Wróć</Text>
                  </Pressable>
                </View>
              ) : null}

              {(status === "done" || (status === "scanning" && browseEarly)) && menu ? (
                <View>
                  {sessionCost > 0 ? (
                    <Text style={styles.sessionCost}>💰 Koszt sesji: ${sessionCost < 0.01 ? sessionCost.toFixed(4) : sessionCost.toFixed(2)}{status === "scanning" ? " · rośnie…" : ""}</Text>
                  ) : null}
                  {status === "scanning" ? (
                    // Przeglądanie w trakcie skanu: baner z paskiem postępu DAŃ. Total rośnie w trakcie
                    // struktury (meta „ucieka"), a po jej zamrożeniu (structureReady) jest stały i pasek
                    // dopełnia się z każdym wzbogaconym daniem.
                    (() => {
                      const menuTotal = menu.sections.reduce((n, s) => n + s.items.length, 0);
                      const total = structureReady ? menuTotal : Math.max(menuTotal, scanItems.length);
                      const enriched = menu.sections.reduce((n, s) => n + s.items.reduce((m, it) => m + (it.enriched ? 1 : 0), 0), 0);
                      const pct = total > 0 ? Math.min(1, enriched / total) : 0;
                      return (
                        <View style={styles.scanBanner}>
                          <ActivityIndicator size="small" color={colors.accent} />
                          <View style={{ flex: 1, marginLeft: 10 }}>
                            <Text style={styles.scanBannerTitle}>
                              {structureReady ? `⏳ Tłumaczę dania ${enriched}/${total}…` : scanProgress ? `⏳ Czytam strony ${scanProgress.done}/${scanProgress.total} · ${total} dań…` : `⏳ Czytam menu · ${total} dań…`}
                            </Text>
                            <View style={styles.progressTrack}>
                              <View style={[styles.progressFill, { width: `${Math.round(pct * 100)}%` }]} />
                            </View>
                            <Text style={styles.scanBannerSub} numberOfLines={1}>
                              {structureReady ? "Struktura gotowa — reszta dochodzi w miejscu." : "Liczba dań jeszcze rośnie…"}{scanFoundName ? ` · 🏠 ${scanFoundName}` : ""}
                            </Text>
                          </View>
                        </View>
                      );
                    })()
                  ) : (
                    // „Nowy skan" przeniesiony do paska zakładek (na stałej wysokości); tu zostaje tylko status.
                    <View style={styles.savedRow}>
                      <Text style={styles.savedNote}>✓ Zapisano w historii</Text>
                    </View>
                  )}
                  {scanFromCache ? (
                    <Text style={styles.cacheNote}>🗄 Odczytane z cache (ten sam plik) — bez kosztu modelu.</Text>
                  ) : null}
                  {/* TEN SAM render co historia — karta lokalu, menu i WSZYSTKIE akcje; w trakcie skanu akcje
                      mutujące są disabled (odblokują się po odczycie). */}
                  {renderMenuDetail({
                    menu,
                    savedScan: freshScanId ? scans.find((s) => s.id === freshScanId) ?? null : null,
                    scanId: freshScanId,
                    restaurant: freshRestaurant,
                    restaurantLoading,
                    targetLang,
                    onItemPress: onFreshItemPress,
                    onSearchMore: onFreshSearchMore,
                    scanning: status === "scanning",
                    enriching: status === "scanning",
                  })}
                </View>
              ) : null}
            </>
          ) : null}
        </ScrollView>
        )}
        <CameraCapture
          visible={showCamera}
          count={images.length}
          onCapture={onSerialCapture}
          onFreeze={onCameraFreeze}
          onClose={() => setShowCamera(false)}
          peekEnabled={peekEnabled}
          onTogglePeek={togglePeek}
          peekInfo={peekInfo}
          peeking={peekingUris.length > 0}
          shots={images.map((img) => ({
            uri: img.uri,
            peek: peekByUri[img.uri],
            peeking: peekingUris.includes(img.uri),
          }))}
          onRemoveShot={removeImageByUri}
        />
        <ApiErrorToast />
        <Lightbox state={sourceLb} onClose={() => setSourceLb(null)} />
        <RenameModal
          visible={!!renameTarget}
          initialValue={renameTarget?.restaurantName ?? renameTarget?.restaurant?.name ?? ""}
          onCancel={() => setRenameTarget(null)}
          onSave={doRename}
        />
        {showVenueSearch ? (
          <View style={StyleSheet.absoluteFill}>
            <VenueSearchScreen
              initialLocation={restaurantCtx?.location ?? freshRestaurant?.location ?? null}
              cuisine={menu?.cuisine ?? restaurantCtx?.menu.cuisine}
              targetLang={targetLang}
              onClose={() => setShowVenueSearch(false)}
              onPick={(r) => { void pickRestaurant(r); setShowVenueSearch(false); }}
            />
          </View>
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { fontSize: 22, fontWeight: "800", color: colors.accent },
  iconRow: { flexDirection: "row", alignItems: "center", gap: 18 },
  iconBtn: { flexDirection: "row", alignItems: "center", gap: 3 },
  icon: { fontSize: 20 },
  iconBadge: { fontSize: 13, fontWeight: "800", color: colors.accent },
  tabs: { flexDirection: "row", alignItems: "center", gap: 20, marginTop: 12 },
  tabsNewScan: { marginLeft: "auto", paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.badgeBg, borderRadius: 999 },
  topProgress: { height: 3, backgroundColor: colors.badgeBg, borderRadius: 999, marginTop: 10, overflow: "hidden" },
  topProgressFill: { height: "100%", backgroundColor: colors.accent, borderRadius: 999 },
  tab: { fontSize: 15, fontWeight: "700", color: colors.muted },
  tabActive: { color: colors.accent, textDecorationLine: "underline" },
  navBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.badgeBg, borderRadius: 999 },
  navText: { color: colors.accent, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 48 },
  intro: { fontSize: 16, color: colors.text, lineHeight: 22, marginBottom: 24 },
  dropZone: {
    borderWidth: 2,
    borderColor: colors.badgeBg,
    borderStyle: "dashed",
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  dropGlyph: { fontSize: 40, marginBottom: 8 },
  dropTitle: { fontSize: 18, fontWeight: "800", color: colors.text },
  dropSub: { fontSize: 13, color: colors.muted, textAlign: "center", marginTop: 6, marginBottom: 16, lineHeight: 18 },
  optionsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    marginTop: 6,
    gap: 10,
  },
  optionsHeadText: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1 },
  optionsChevron: { fontSize: 18, color: colors.muted },
  optionsBody: { marginBottom: 6 },
  label: { fontSize: 13, fontWeight: "700", color: colors.muted, marginBottom: 8, marginTop: 8 },
  replayLocNote: { fontSize: 12, color: colors.accent, backgroundColor: colors.accent + "14", borderRadius: 8, padding: 8, marginBottom: 8, lineHeight: 16 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.badgeBg },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: "600" },
  chipTextActive: { color: colors.buttonText },
  modelsLink: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: colors.badgeBg },
  modelsLinkText: { fontSize: 12, color: colors.accent, fontWeight: "700" },
  modelRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 8 },
  modelCard: {
    flexGrow: 1,
    flexBasis: "46%",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  modelCardActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  modelLabel: { fontSize: 15, fontWeight: "700", color: colors.text },
  modelLabelActive: { color: colors.buttonText },
  modelHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  modelHintActive: { color: colors.buttonText, opacity: 0.85 },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.badgeBg,
    marginBottom: 16,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  switchTextWrap: { flex: 1, paddingRight: 12 },
  switchTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  switchSub: { fontSize: 12, color: colors.muted, marginTop: 3, lineHeight: 16 },
  thumbRow: { flexDirection: "row", marginBottom: 16 },
  thumbWrap: { marginRight: 10, position: "relative" },
  thumb: { width: 80, height: 100, borderRadius: 8, backgroundColor: colors.badgeBg },
  thumbBadDim: { opacity: 0.45 },
  thumbBad: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "rgba(160,30,30,0.92)", paddingVertical: 2, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  thumbPartial: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "rgba(190,120,20,0.92)", paddingVertical: 2, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  thumbBadText: { color: "#fff", fontSize: 9, fontWeight: "800", textAlign: "center" },
  thumbRemove: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbRemoveText: { color: colors.buttonText, fontSize: 16, fontWeight: "800", lineHeight: 18 },
  thumbIndex: {
    position: "absolute",
    bottom: 4,
    left: 4,
    color: colors.buttonText,
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 6,
    borderRadius: 8,
    overflow: "hidden",
  },
  addRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  addBtn: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  addBtnText: { color: colors.accent, fontSize: 15, fontWeight: "700" },
  button: { borderRadius: 12, paddingVertical: 16, alignItems: "center", marginBottom: 12 },
  primary: { backgroundColor: colors.accent },
  danger: { backgroundColor: colors.error, marginTop: 20 },
  secondary: { backgroundColor: colors.badgeBg, marginTop: 20 },
  secondaryText: { color: colors.accent, fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.buttonText, fontSize: 16, fontWeight: "700" },
  // Krok „Potwierdź lokal" po skanie.
  confirmBox: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  cacheNote: { fontSize: 12, color: colors.muted, marginBottom: 12, fontStyle: "italic" },
  wrongVenueBtn: { marginTop: 10, alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 9, backgroundColor: colors.badgeBg },
  wrongVenueText: { color: colors.accent, fontWeight: "800", fontSize: 13 },
  lookupRow: { flexDirection: "row", gap: 10, marginBottom: 16 },
  searchNearbyBtn: {
    flex: 1,
    backgroundColor: colors.badgeBg,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  searchNearbyText: { color: colors.accent, fontSize: 15, fontWeight: "700" },
  inlineError: { color: colors.error, fontSize: 14, textAlign: "center", marginTop: 4 },
  savedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  savedNote: { color: colors.accent, fontWeight: "700", fontSize: 15 },
  scanReadyBox: { alignSelf: "stretch", marginTop: 16 },
  scanReadyVenueHdr: { fontSize: 13, fontWeight: "800", color: colors.muted, marginHorizontal: 16, marginBottom: 8 },
  sessionCost: { fontSize: 12, fontWeight: "700", color: colors.muted, textAlign: "right", marginBottom: 8 },
  scanBanner: { flexDirection: "row", alignItems: "center", backgroundColor: colors.badgeBg, borderRadius: 12, padding: 12, marginBottom: 16 },
  scanBannerTitle: { fontSize: 14, fontWeight: "800", color: colors.accent },
  scanBannerSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  geo: { fontSize: 13, color: colors.muted, marginTop: 12 },
  sourcePhotosBtn: { marginTop: 12, alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.badgeBg, borderRadius: 999 },
  sourcePhotosText: { color: colors.accent, fontWeight: "700", fontSize: 14 },
  metaCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginTop: 14,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  metaTitle: { fontSize: 14, fontWeight: "800", color: colors.text, marginBottom: 6 },
  metaRow: { fontSize: 13, color: colors.text, marginTop: 2 },
  metaHint: { fontSize: 11, color: colors.muted, marginTop: 8, lineHeight: 16 },
  center: { alignItems: "center", paddingVertical: 48 },
  scanning: { fontSize: 18, fontWeight: "700", color: colors.text, marginTop: 16, textAlign: "center" },
  scanningSub: { fontSize: 13, color: colors.muted, marginTop: 6, textAlign: "center" },
  scanThumbsWrap: { alignItems: "center", marginTop: 14, alignSelf: "stretch" },
  scanThumbsRow: { paddingHorizontal: 16, gap: 8 },
  scanThumb: { width: 84, height: 110, borderRadius: 10, backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: colors.accent },
  scanPhase: { fontSize: 14, fontWeight: "600", color: colors.accent, marginTop: 12, textAlign: "center" },
  scanFoundName: { marginTop: 12, fontSize: 14, fontWeight: "800", color: colors.accent, alignSelf: "stretch", marginHorizontal: 16, textAlign: "center" },
  scanItemsHdr: { marginTop: 14, fontSize: 13, fontWeight: "700", color: colors.muted, alignSelf: "stretch", marginHorizontal: 16 },
  scanItemsBox: { marginTop: 6, maxHeight: 320, alignSelf: "stretch", marginHorizontal: 12 },
  scanCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  scanCardThumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: colors.badgeBg, marginRight: 10 },
  scanItemThumbEmpty: { alignItems: "center", justifyContent: "center" },
  scanCardBody: { flex: 1, minWidth: 0 },
  scanCardName: { fontSize: 14, fontWeight: "700", color: colors.text },
  scanCardDesc: { fontSize: 12, color: colors.muted, marginTop: 1 },
  scanCardPrice: { fontSize: 14, fontWeight: "800", color: colors.accent, marginLeft: 8 },
  progressTrack: {
    width: "70%",
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.badgeBg,
    marginTop: 12,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 999, backgroundColor: colors.accent },
  errorTitle: { fontSize: 18, fontWeight: "700", color: colors.error, marginBottom: 8 },
  errorMsg: { fontSize: 14, color: colors.text, textAlign: "center", marginBottom: 24 },
});
