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
  updateScanRestaurant,
  addScanUsage,
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
  type ScanCapture,
} from "./src/captures";
import { MenuView } from "./src/MenuView";
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
  type ModelId,
  type ModelRole,
  type PhotoDebug,
  type RestaurantInfo,
  type TripAdvisorPhoto,
  type Usage,
} from "./src/types";

// Domyślny zasięg szukania lokalu „w pobliżu" (m). Można zwiększać „szerszym zasięgiem".
const DEFAULT_NEARBY_RADIUS = 800;

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

export default function App() {
  const [tab, setTab] = useState<Tab>("scan");
  const [openScan, setOpenScan] = useState<SavedScan | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [showCaptures, setShowCaptures] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [captures, setCaptures] = useState<ScanCapture[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  // Postęp analizy gdy skan idzie partiami (duże menu). null = brak/jedna partia.
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  // Faza bieżącej partii skanu (wysyłka % → model czyta z licznikiem) — żywy sygnał postępu.
  const [scanPhase, setScanPhase] = useState<{ label: string; pct?: number } | null>(null);
  // Skan NIEKOMPLETNY: ile partii padło i jest dokańczanych w tle (null = komplet). Apka wpuszcza
  // do menu z tym, co przeszło, a resztę dolicza w tle — bez powtarzania udanych partii.
  const [scanIncomplete, setScanIncomplete] = useState<{ pending: number; working: boolean } | null>(null);
  // Czy choć jedna partia skanu wróciła Z CACHE (ten sam plik) — do informacji o oszczędności.
  const [scanFromCache, setScanFromCache] = useState(false);
  // Aktualnie analizowane zdjęcie (URI miniatury) — przy skanie per-zdjęcie pokazuje, co idzie teraz.
  const [scanCurrentImage, setScanCurrentImage] = useState<string | null>(null);
  // Ręczne ponowienie dokończenia skanu (gdy auto-doliczanie w tle też padło) — z banera.
  const retryScanRef = useRef<null | (() => void)>(null);
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
  // Model AI osobno per miejsce użycia (skan/opisy/weryfikacja/venue) — patrz Ustawienia.
  const [models, setModels] = useState<Record<ModelRole, ModelId>>(DEFAULT_MODELS);

  const [scans, setScans] = useState<SavedScan[]>([]);
  const [freshScanId, setFreshScanId] = useState<string | null>(null);
  const [infoLoading, setInfoLoading] = useState<Set<string>>(new Set()); // generowanie opisu
  const [photoLoading, setPhotoLoading] = useState<Set<string>>(new Set()); // doszukiwanie lepszych zdjęć
  const [freshRestaurant, setFreshRestaurant] = useState<RestaurantInfo | null>(null);
  const [restaurantLoading, setRestaurantLoading] = useState(false);
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
  // Krok „Potwierdź lokal" po świeżym skanie (potwierdź / wybierz inny / wyszukaj / pomiń).
  const [venueConfirmed, setVenueConfirmed] = useState(true);
  const [venueQuery, setVenueQuery] = useState("");

  useEffect(() => {
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

  // Przycisk „Aparat": zawsze nasz własny ekran aparatu (podgląd każdego zdjęcia + dodawanie serii).
  function openCamera() {
    setPeekInfo(null); // świeża sesja podglądu
    setShowCamera(true);
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
      const r = await quickPeek({ base64: img.base64, mediaType: img.mediaType }, models.peek);
      setPeekInfo(r);
      setPeekByUri((prev) => ({ ...prev, [img.uri]: r })); // ocena dla tego konkretnego zdjęcia
      setHint((h) => (h.trim() ? h : r.restaurantName || h)); // nie nadpisuj, gdy user już coś wpisał
    } catch {
      // podgląd jest tylko pomocniczy — błąd ignorujemy
    } finally {
      setPeekingUris((p) => p.filter((u) => u !== img.uri));
    }
  }

  // Tryb seryjny: każde zdjęcie z własnego aparatu → przetwórz i dołóż (do limitu).
  async function onSerialCapture(uri: string, exif?: Record<string, unknown> | null) {
    try {
      const img = await prepareCameraPhoto(uri, exif);
      setReplayLocation(null); // nowe zdjęcie z aparatu → przestajemy wymuszać lokalizację z migawki
      setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, img]));
      if (peekEnabled) void runPeek(img); // szybki podgląd w tle dla każdego zatrzymanego kadru
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

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  // Usuwa zdjęcie po uri (z galerii aparatu) + sprząta jego ocenę peek.
  function removeImageByUri(uri: string) {
    setImages((prev) => prev.filter((i) => i.uri !== uri));
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
        capture = await saveCapture({
          images: opts.images,
          restaurantHint: opts.hint.trim() || undefined,
          locationHint,
          location,
          locationSource,
          useExifLocation: opts.useExifLocation,
          useDeviceLocation: opts.useDeviceLocation,
        }).catch(() => null);
        listCaptures().then(setCaptures).catch(() => {});
      }

      // Skan PARTIAMI: dużą liczbę zdjęć dzielimy na partie po SCAN_BATCH i scalamy
      // wyniki z deduplikacją (mniejsze, bezpieczne wywołania + widoczny postęp).
      const batches: PreparedImage[][] = [];
      for (let i = 0; i < opts.images.length; i += SCAN_BATCH)
        batches.push(opts.images.slice(i, i + SCAN_BATCH));

      let merged: Menu | null = null;
      let scanId: string | null = null;
      // Odporność: partie, które padły (zapamiętujemy ich zdjęcia + indeks, by dokończyć w tle —
      // tylko te, nie od początku). Plus znacznik, czy coś wróciło z cache (oszczędność).
      const failedBatches: { idx: number; images: PreparedImage[] }[] = [];
      let anyCached = false;
      setScanIncomplete(null);
      setScanFromCache(false);

      // PREFETCH zdjęć poglądowych NA ŻYWO: gdy model wypisze pozycję, od razu dociągamy dla niej
      // tanie zdjęcie (Serper) — gotowe, zanim skan się skończy; potem reużyte (bez ponownego szukania).
      prefetchedPhotos.current.clear();
      setScanItems([]);
      const eff = opts.models;
      const pfQueue: ScanItemStub[] = [];
      let pfActive = 0;
      let pfEnqueued = 0; // szanuje limit auto-dociągania (Koszty)
      const pumpPrefetch = () => {
        // Łagodnie (2 równolegle) — żeby prefetch nie dociążał strumienia skanu (ryzyko urwania).
        while (pfActive < 2 && pfQueue.length > 0) {
          const stub = pfQueue.shift()!;
          pfActive++;
          void (async () => {
            try {
              const { photos } = await fetchDishPhotos(stub.original, undefined, {
                representativeOnly: true,
                num: 1,
                photoQuery: stub.photoQuery,
                verifyModel: eff.verify,
              });
              if (photos.length > 0) {
                const cached = await cachePhotos(photos);
                prefetchedPhotos.current.set(stub.original, cached);
                const thumb = cached[0]?.url;
                setScanItems((prev) => prev.map((x) => (x.original === stub.original ? { ...x, photo: thumb } : x)));
                // Jeśli menu już jest (kolejne partie) — wstaw od razu, z guardem (nie nadpisuj lepszych).
                setMenu((prev) => (prev ? attachPhotosByName(prev, stub.original, cached) : prev));
              }
            } catch {
              /* ciche — fillDishPhotos po skanie dociągnie brakujące */
            } finally {
              pfActive--;
              pumpPrefetch();
            }
          })();
        }
      };
      const onScanItem = (stub: ScanItemStub) => {
        // Nazwy pokazujemy zawsze (za darmo); zdjęcia prefetchujemy gdy auto-zdjęcia włączone i w
        // ramach limitu z „Kosztów". Markowe też (Coca-Cola itp.) — dostają czysty generyk produktowy,
        // żeby w podglądzie na żywo nie zostawały bez miniatury.
        setScanItems((prev) => [
          ...prev,
          { original: stub.original, translated: stub.translated, branded: stub.branded, price: stub.price, currency: stub.currency, description: stub.description },
        ]);
        // Prefetch TYLKO gdy mamy sensowne photo_query. W dwuprzebiegu struktura strumieniuje nazwy
        // bez photo_query (puste) — wtedy NIE prefetchujemy po surowej nazwie (zły wynik by się
        // „przykleił"); zdjęcia dociągnie fillDishPhotos po enrich z właściwym photo_query.
        if (stub.photoQuery && stub.photoQuery.trim() && costPrefs.autoPhotos && (costPrefs.autoLimit <= 0 || pfEnqueued < costPrefs.autoLimit)) {
          pfEnqueued++;
          pfQueue.push(stub);
          pumpPrefetch();
        }
      };
      // Enrich NA ŻYWO: gdy dla pozycji dojdzie opis + photo_query → uzupełnij kartę i dociągnij zdjęcie.
      const onEnrichItem = (stub: ScanItemStub) => {
        setScanItems((prev) => prev.map((x) => (x.original === stub.original
          ? { ...x, translated: stub.translated || x.translated, description: stub.description || x.description }
          : x)));
        if (stub.photoQuery && stub.photoQuery.trim() && costPrefs.autoPhotos && (costPrefs.autoLimit <= 0 || pfEnqueued < costPrefs.autoLimit)) {
          pfEnqueued++;
          pfQueue.push(stub);
          pumpPrefetch();
        }
      };
      if (batches.length > 1) setScanProgress({ done: 0, total: opts.images.length });

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi]!;
        setScanCurrentImage(batch[0]?.uri ?? null); // pokaż aktualnie analizowaną fotkę
        // Dla kolejnych partii dajemy modelowi kontekst (nazwa/kuchnia) z dotychczasowego menu.
        const batchHint = merged
          ? [merged.restaurant_name, merged.cuisine].filter(Boolean).join(" ") || undefined
          : opts.hint.trim() || undefined;
        let incoming: Menu, usage: Usage, cached: boolean;
        try {
          ({ menu: incoming, usage, cached } = await scanMenu(
            {
              images: batch.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
              targetLang: opts.targetLang,
              restaurantHint: batchHint,
              locationHint,
              cuisineHint: pickPeekCuisine(), // kontekst kuchni z „szybkiego podglądu"
              model: opts.models.scan,
              enrichModel: opts.models.enrich,
            },
            (p) => setScanPhase(scanPhaseLabel(p)),
            onScanItem,
            onEnrichItem,
          ));
        } catch {
          // Partia padła (sieć/serwer) — NIE wywalamy całego skanu: zapamiętaj do dokończenia w tle
          // (tylko tę partię) i jedź dalej. Cache skanu sprawi, że jeśli serwer policzył a odpowiedź
          // zginęła — ponowienie tej partii jest darmowe.
          failedBatches.push({ idx: bi, images: batch });
          continue;
        }
        if (cached) anyCached = true;

        if (!merged) {
          // Pierwsza partia → bazowe menu + zapis (kolejne tylko dokładają).
          merged = incoming;
          if (opts.hint.trim()) merged.restaurant_name = opts.hint.trim(); // nazwa od usera ma pierwszeństwo
          const saved = await saveScan({
            menu: merged,
            targetLang: opts.targetLang,
            model: opts.models.scan,
            models: opts.models,
            location,
            locationSource,
            useExifLocation: opts.useExifLocation,
            useDeviceLocation: opts.useDeviceLocation,
            usage,
          });
          scanId = saved.id;
          setFreshScanId(saved.id);
        } else {
          merged = mergeMenus(merged, incoming).menu;
          await updateScanMenu(scanId!, merged);
          await addScanUsage(scanId!, usage);
        }
        setMenu(merged);
        if (batches.length > 1) {
          setScanProgress({ done: Math.min((bi + 1) * SCAN_BATCH, opts.images.length), total: opts.images.length });
        }
        setScans(await listScans());
      }
      if (anyCached) setScanFromCache(true);

      // Żadna partia nie przeszła → realny błąd (nie ma czego pokazać).
      if (!merged || !scanId) {
        throw new Error("Odczyt menu nie powiódł się (żadna partia nie przeszła) — spróbuj ponownie.");
      }

      setScanProgress(null);
      setScanPhase(null);
      setScanCurrentImage(null);
      setStatus("done");
      setVenueConfirmed(false); // pokaż krok potwierdzenia lokalu
      setVenueQuery("");
      const result = merged;

      // REUŻYCIE prefetchu: dołącz do menu zdjęcia poglądowe dociągnięte już w trakcie skanu —
      // dzięki temu pokazują się od razu, a fillDishPhotos je pominie (bez ponownego szukania).
      result.sections.forEach((sec) =>
        sec.items.forEach((it) => {
          if (it && !(it.photos && it.photos.length > 0)) {
            const pf = prefetchedPhotos.current.get(it.original);
            if (pf && pf.length > 0) it.photos = pf;
          }
        }),
      );
      setMenu(result);
      if (scanId) void updateScanMenu(scanId, result);
      setScanItems([]);

      // Powiąż migawkę z zapisanym skanem → eksport dołączy WYNIK (do analizy „co źle").
      if (capture && scanId) void addCaptureRun(capture.id, scanId).catch(() => {});

      // Namierzenie lokalu: mamy nazwę → automatycznie po nazwie (pewne). Brak nazwy →
      // NIE zgadujemy po GPS automatycznie; ustawiamy tylko kontekst, a user kliknie.
      setFreshRestaurant(null);
      setRestaurantCtx({
        menu: result,
        location,
        scanId: scanId!,
        lang: opts.targetLang,
        apply: setFreshRestaurant,
        applyMenu: setMenu,
        current: null,
        candidates: [],
      });
      if (result.restaurant_name) {
        void lookupRestaurant(result, location, scanId!, opts.targetLang, setFreshRestaurant, {
          applyMenu: setMenu,
        });
      }

      // Tło, równolegle z automatu: (a) tanie zdjęcia poglądowe, (b) pełne opisy dań
      // (gotowe ad-hoc). Sterowane „Kosztami": wyłączniki + limit dań (reszta na dotknięcie).
      if (costPrefs.autoPhotos) void fillDishPhotos(result, scanId, result.restaurant_name ?? undefined, setMenu);
      if (costPrefs.autoDescriptions) void fillDescriptions(result, scanId, opts.targetLang, setMenu);

      // ODPORNOŚĆ: część partii padła → wpuszczamy do menu z tym, co mamy, a brakujące partie
      // doliczamy w TLE (tylko one — nie od początku). Baner informuje o doliczaniu.
      if (failedBatches.length > 0) {
        setScanIncomplete({ pending: failedBatches.length, working: true });
        void completeFailedBatches(scanId, opts, locationHint, pickPeekCuisine(), failedBatches, result);
      }
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { stack: e instanceof Error ? e.stack : undefined, label: "scan", context: { images: opts.images.length, model: opts.models.scan } });
      setError(friendlyMessage(e instanceof Error ? e.message : undefined));
      setStatus("error");
      setScanProgress(null);
      setScanPhase(null);
      setScanCurrentImage(null);
      setScanItems([]);
    }
  }

  // Dokańcza w TLE partie skanu, które padły (sieć/serwer): ponawia TYLKO je, scala z menu i
  // zapisuje. Cache skanu sprawia, że jeśli serwer już policzył (a odpowiedź zginęła), ponowienie
  // jest DARMOWE. 2 podejścia; jak dalej się nie uda — baner z ręcznym ponowieniem (retryScanRef).
  async function completeFailedBatches(
    scanId: string,
    opts: { targetLang: string; models: Record<ModelRole, ModelId> },
    locationHint: string | undefined,
    cuisineHint: string | undefined,
    failed: { idx: number; images: PreparedImage[] }[],
    baseMenu: Menu,
  ) {
    let acc = baseMenu;
    let remaining = [...failed];
    for (let pass = 0; pass < 2 && remaining.length > 0; pass++) {
      const stillFailed: typeof remaining = [];
      for (const fb of remaining) {
        try {
          const hint = [acc.restaurant_name, acc.cuisine].filter(Boolean).join(" ") || undefined;
          const { menu: incoming, usage } = await scanMenu({
            images: fb.images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
            targetLang: opts.targetLang,
            restaurantHint: hint,
            locationHint,
            cuisineHint,
            model: opts.models.scan,
            enrichModel: opts.models.enrich,
          });
          acc = mergeMenus(acc, incoming).menu;
          await updateScanMenu(scanId, acc);
          await addScanUsage(scanId, usage);
          const done = acc;
          setMenu((prev) => (prev ? done : prev)); // odśwież widok, jeśli ten skan jest otwarty
          setScanIncomplete((p) => (p ? { ...p, pending: Math.max(0, p.pending - 1) } : p));
        } catch {
          stillFailed.push(fb);
        }
      }
      remaining = stillFailed;
      if (remaining.length > 0) await new Promise((r) => setTimeout(r, 2500));
    }
    if (remaining.length === 0) {
      setScanIncomplete(null);
      retryScanRef.current = null;
      setScans(await listScans());
      if (costPrefs.autoPhotos) void fillDishPhotos(acc, scanId, acc.restaurant_name ?? undefined, setMenu);
      if (costPrefs.autoDescriptions) void fillDescriptions(acc, scanId, opts.targetLang, setMenu);
    } else {
      const left = remaining;
      const accFinal = acc;
      retryScanRef.current = () => {
        setScanIncomplete({ pending: left.length, working: true });
        void completeFailedBatches(scanId, opts, locationHint, cuisineHint, left, accFinal);
      };
      setScanIncomplete({ pending: remaining.length, working: false });
    }
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
    // Wstaw dane migawki do formularza skanu (bez startu — czekamy na klik użytkownika).
    setImages(imgs);
    setHint(c.restaurantHint ?? "");
    setUseExifLocation(c.useExifLocation);
    setUseDeviceLocation(c.useDeviceLocation);
    // Wymuś lokalizację z migawki przy ponownym skanie (eksperyment 1:1 na starej próbce).
    setReplayLocation({ location: c.location, locationSource: c.locationSource, locationHint: c.locationHint });
  }

  function resetScan() {
    setImages([]);
    setReplayLocation(null);
    setMenu(null);
    setError(null);
    setStatus("idle");
    setFreshRestaurant(null);
    setFreshScanId(null);
    setRestaurantCtx(null);
    setVenueConfirmed(true);
    setVenueQuery("");
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
    opts?: { forceNearby?: boolean; applyMenu?: (u: (prev: Menu | null) => Menu | null) => void },
  ) {
    const forceNearby = opts?.forceNearby ?? false;
    const applyMenu = opts?.applyMenu ?? restaurantCtx?.applyMenu ?? setMenu;
    const prevVenue = restaurantCtx?.current ?? null;
    // forceNearby wymaga GPS; zwykłe wyszukiwanie — nazwy ALBO GPS (fallback).
    if (forceNearby ? !location : !m.restaurant_name && !location) return;
    // Zapamiętaj kontekst karty (do „wybierz / szukaj w pobliżu / usuń").
    setRestaurantCtx({ menu: m, location, scanId, lang, apply, applyMenu, current: prevVenue, candidates: [] });
    setRestaurantLoading(true);
    try {
      const { restaurant: r, candidates } = await fetchRestaurant({
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
      // Mamy teraz lokal (strona www + pewna nazwa + podpisy TripAdvisora) → doszukaj
      // zdjęć Z TEGO LOKALU dla dań bez potwierdzonego (★). Gdy lokal się ZMIENIŁ na inny,
      // zdejmij najpierw nieaktualne ★ (z poprzedniego lokalu), by potwierdzić od nowa.
      const baseForUpgrade = await rebaseVenue(m, scanId, applyMenu, prevVenue, r);
      if (costPrefs.autoVenuePhotos) void upgradeVenuePhotos(baseForUpgrade, scanId, cached, applyMenu);
    } catch {
      // ciche niepowodzenie — karta lokalu po prostu się nie pokaże
    } finally {
      setRestaurantLoading(false);
    }
  }

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

  // Ręczne wyszukanie lokalu z wpisanego tekstu (nazwa, ewentualnie + miasto) — działa też
  // BEZ GPS. Wpisaną frazę traktujemy jak nazwę do wyszukania (lokalizacja jako bias, gdy jest).
  function searchVenueText(query: string) {
    if (!restaurantCtx) return;
    const q = query.trim();
    if (!q) return;
    void lookupRestaurant(
      { ...restaurantCtx.menu, restaurant_name: q },
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

  // „Szerszy zasięg" — podwój promień ostatniego szukania (z górnym limitem).
  function expandNearby() {
    const r = Math.min((restaurantCtx?.radius ?? DEFAULT_NEARBY_RADIUS) * 2, 8000);
    void searchNearby(r, false);
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
      applyMenu(() => demoted);
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
          candidates={restaurantCtx?.candidates}
          nearbyLoading={nearbyLoading}
          onPick={pickRestaurant}
          onSearchByName={name ? searchByName : undefined}
          onSearchNearby={hasLoc ? () => searchNearby(DEFAULT_NEARBY_RADIUS, false) : undefined}
          onExpandSearch={hasLoc ? expandNearby : undefined}
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
    await deleteScan(id);
    setScans(await listScans());
    if (openScan?.id === id) setOpenScan(null);
  }

  // Scala zdjęcia: LEPSZE (świeże) z przodu, dotychczasowe na końcu — bez duplikatów i bez
  // znikania już wyszukanych. Dedup po remoteUrl/url (te same źródła = ten sam plik cache).
  function mergePhotos(fresh: DishPhotoLite[], old: DishPhotoLite[]): DishPhotoLite[] {
    const key = (p: DishPhotoLite) => p.remoteUrl ?? p.url;
    const seen = new Set(fresh.map(key));
    return [...fresh, ...old.filter((p) => !seen.has(key(p)))];
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
        opts.applyMenu((prev) => (prev ? patchItem(prev, si, ii, { extraInfo: info }) : prev));
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

    // === FAZA 2: LEPSZE ZDJĘCIA — w tle, NIE blokuje (opis już widoczny). ===
    if (!item.photosUpgraded && !photoLoading.has(key)) {
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
          num: 1,
          verifyModel: eff.verify,
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
    applyMenu(() => demoted);
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
          if (cur?.extraInfo) return prev; // user już dostał z dotknięcia
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

  function onFreshItemPress(si: number, ii: number) {
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
        applyMenu: setMenu,
      });
  }

  function onDetailItemPress(si: number, ii: number) {
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
      applyMenu: makeApplyMenu(openScan.id, true),
    });
  }

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
                <Text style={[styles.tab, tab === "scan" && styles.tabActive]}>Skanuj</Text>
              </Pressable>
              <Pressable onPress={() => setTab("history")}>
                <Text style={[styles.tab, tab === "history" && styles.tabActive]}>
                  Historia{scans.length ? ` (${scans.length})` : ""}
                </Text>
              </Pressable>
            </View>
          ) : null}
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
          {showingDetail && openScan ? (
            <View>
              {renderRestaurant(openScan.restaurant ?? null)}
              <MenuView
                menu={openScan.menu}
                infoLoading={infoLoading}
                photoLoading={photoLoading}
                onItemPress={onDetailItemPress}
                nameFallback={openScan.restaurant?.name}
              />
              {openScan.location ? (
                <Text style={styles.geo}>
                  📍 {openScan.location.lat.toFixed(5)}, {openScan.location.lng.toFixed(5)}
                  {openScan.locationSource === "exif"
                    ? "  (ze zdjęcia)"
                    : openScan.locationSource === "device"
                      ? "  (Twoja pozycja przy skanie)"
                      : ""}
                </Text>
              ) : (
                <Text style={styles.geo}>
                  📍 Bez zapisanej pozycji
                  {openScan.useExifLocation === false && openScan.useDeviceLocation === false
                    ? " (lokalizacja była wyłączona przy skanie)"
                    : ""}
                </Text>
              )}
              {renderScanMeta(openScan)}
              <Pressable
                style={[styles.button, styles.secondary, appending && styles.disabled]}
                disabled={appending}
                onPress={() =>
                  chooseAppendSource(openScan.id, openScan.menu, openScan.targetLang, true)
                }
              >
                <Text style={styles.secondaryText}>
                  {appending ? "⏳ Dokładam zdjęcia…" : "➕ Dodaj zdjęcia (uzupełnij menu)"}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPress={() => refreshScanPhotos(openScan.id, openScan.menu, true, openScan.restaurant)}
              >
                <Text style={styles.secondaryText}>
                  {openScan.restaurant ? "🔄 Odśwież zdjęcia (doszukaj z lokalu)" : "🔄 Odśwież zdjęcia dań"}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPress={() => setRenameTarget(openScan)}
              >
                <Text style={styles.secondaryText}>✏️ Zmień nazwę menu</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.danger]} onPress={() => removeSaved(openScan.id)}>
                <Text style={styles.buttonText}>Usuń z historii</Text>
              </Pressable>
            </View>
          ) : null}

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
                        onChangeText={setHint}
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

              {status === "scanning" ? (
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
                  {scanCurrentImage ? (
                    <View style={styles.scanCurrentWrap}>
                      <Image source={{ uri: scanCurrentImage }} style={styles.scanCurrentImg} />
                      <Text style={styles.scanningSub}>Analizuję to zdjęcie…</Text>
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

              {status === "done" && menu ? (
                <View>
                  <View style={styles.savedRow}>
                    <Text style={styles.savedNote}>✓ Zapisano w historii</Text>
                    <Pressable onPress={resetScan} style={styles.navBtn}>
                      <Text style={styles.navText}>＋ Nowy skan</Text>
                    </Pressable>
                  </View>
                  {scanIncomplete ? (
                    <View style={styles.incompleteBox}>
                      <Text style={styles.incompleteTitle}>⚠️ Menu może być niekompletne</Text>
                      <Text style={styles.incompleteSub}>
                        {scanIncomplete.working
                          ? `Część stron nie przeszła — dolicza się w tle (pozostało ${scanIncomplete.pending}). Możesz już czytać; brakujące dania dojdą same.`
                          : `Nie udało się doczytać ${scanIncomplete.pending} part. menu. Spróbuj dokończyć przy lepszym zasięgu — powtórzymy tylko brakujące strony.`}
                      </Text>
                      {!scanIncomplete.working ? (
                        <Pressable style={styles.incompleteBtn} onPress={() => retryScanRef.current?.()}>
                          <Text style={styles.incompleteBtnText}>↻ Dokończ brakujące</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                  {scanFromCache ? (
                    <Text style={styles.cacheNote}>🗄 Odczytane z cache (ten sam plik) — bez kosztu modelu.</Text>
                  ) : null}
                  {!venueConfirmed ? (
                    <View style={styles.confirmBox}>
                      <Text style={styles.confirmTitle}>📍 Potwierdź lokal</Text>
                      <Text style={styles.confirmSub}>
                        Pewny lokal poprawia zdjęcia (★ z lokalu) i opisy dań. Wybierz właściwy,
                        wyszukaj inny po nazwie/mieście, albo pomiń — menu i tak jest zapisane.
                      </Text>
                      {renderRestaurant(freshRestaurant)}
                      <View style={styles.venueSearchRow}>
                        <TextInput
                          value={venueQuery}
                          onChangeText={setVenueQuery}
                          placeholder="Szukaj lokalu: nazwa, miasto…"
                          placeholderTextColor={colors.muted}
                          style={styles.venueSearchInput}
                          returnKeyType="search"
                          onSubmitEditing={() => searchVenueText(venueQuery)}
                        />
                        <Pressable
                          style={styles.venueSearchBtn}
                          onPress={() => searchVenueText(venueQuery)}
                        >
                          <Text style={styles.venueSearchBtnText}>🔎</Text>
                        </Pressable>
                      </View>
                      <View style={styles.confirmActions}>
                        <Pressable
                          style={[styles.confirmYes, !freshRestaurant && styles.disabled]}
                          disabled={!freshRestaurant}
                          onPress={() => setVenueConfirmed(true)}
                        >
                          <Text style={styles.confirmYesText}>
                            {freshRestaurant ? "✓ Tak, to ten lokal" : "Najpierw wybierz lokal"}
                          </Text>
                        </Pressable>
                        <Pressable style={styles.confirmSkip} onPress={() => setVenueConfirmed(true)}>
                          <Text style={styles.confirmSkipText}>Pomiń</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    renderRestaurant(freshRestaurant)
                  )}
                  <MenuView
                    menu={menu}
                    infoLoading={infoLoading}
                    photoLoading={photoLoading}
                    onItemPress={onFreshItemPress}
                    nameFallback={freshRestaurant?.name}
                  />
                  {freshScanId ? (
                    <Pressable
                      style={[styles.button, styles.secondary, appending && styles.disabled]}
                      disabled={appending}
                      onPress={() =>
                        chooseAppendSource(freshScanId, menu, targetLang, false)
                      }
                    >
                      <Text style={styles.secondaryText}>
                        {appending ? "⏳ Dokładam zdjęcia…" : "➕ Dodaj zdjęcia (uzupełnij menu)"}
                      </Text>
                    </Pressable>
                  ) : null}
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
        <RenameModal
          visible={!!renameTarget}
          initialValue={renameTarget?.restaurantName ?? renameTarget?.restaurant?.name ?? ""}
          onCancel={() => setRenameTarget(null)}
          onSave={doRename}
        />
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
  tabs: { flexDirection: "row", gap: 20, marginTop: 12 },
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
  confirmTitle: { fontSize: 16, fontWeight: "800", color: colors.accent, marginBottom: 4 },
  confirmSub: { fontSize: 13, color: colors.muted, marginBottom: 12, lineHeight: 18 },
  incompleteBox: { backgroundColor: "#FFF3D6", borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#E8C170" },
  incompleteTitle: { fontSize: 14, fontWeight: "800", color: "#8A5A00", marginBottom: 3 },
  incompleteSub: { fontSize: 12.5, color: "#6A5A2A", lineHeight: 17 },
  incompleteBtn: { marginTop: 8, alignSelf: "flex-start", backgroundColor: "#8A5A00", borderRadius: 9, paddingVertical: 8, paddingHorizontal: 14 },
  incompleteBtnText: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  cacheNote: { fontSize: 12, color: colors.muted, marginBottom: 12, fontStyle: "italic" },
  venueSearchRow: { flexDirection: "row", gap: 8, marginTop: 4, marginBottom: 12 },
  venueSearchInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  venueSearchBtn: {
    paddingHorizontal: 16,
    justifyContent: "center",
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
  },
  venueSearchBtnText: { color: colors.accent, fontWeight: "700", fontSize: 16 },
  confirmActions: { flexDirection: "row", gap: 10 },
  confirmYes: { flex: 1, backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  confirmYesText: { color: colors.buttonText, fontWeight: "800", fontSize: 15 },
  confirmSkip: {
    paddingHorizontal: 18,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
  },
  confirmSkipText: { color: colors.muted, fontWeight: "700", fontSize: 15 },
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
  geo: { fontSize: 13, color: colors.muted, marginTop: 12 },
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
  scanCurrentWrap: { alignItems: "center", marginTop: 14 },
  scanCurrentImg: { width: 120, height: 150, borderRadius: 10, backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: colors.accent },
  scanPhase: { fontSize: 14, fontWeight: "600", color: colors.accent, marginTop: 12, textAlign: "center" },
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
