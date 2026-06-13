import { useEffect, useState } from "react";
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
  fetchDishInfo,
  fetchDishPhotos,
  fetchRestaurant,
  fetchVenuePhotos,
  placePhotoUrl,
  type VenueMatch,
} from "./src/api";
import { cacheImage, cachePhotos } from "./src/imageCache";
import { mergeMenus } from "./src/mergeMenu";
import {
  captureFromCamera,
  pickFromLibrary,
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
  type SavedScan,
} from "./src/storage";
import { MenuView } from "./src/MenuView";
import { HistoryView } from "./src/HistoryView";
import { DiagnosticsView } from "./src/DiagnosticsView";
import { ApiErrorToast } from "./src/Toast";
import { friendlyMessage } from "./src/appLog";
import { RenameModal } from "./src/RenameModal";
import { RestaurantCard } from "./src/RestaurantCard";
import { colors } from "./src/theme";
import {
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  ZERO_USAGE,
  addUsage,
  type DishPhotoLite,
  type GeoPoint,
  type LocationSource,
  type Menu,
  type ModelId,
  type RestaurantInfo,
  type TripAdvisorPhoto,
  type Usage,
} from "./src/types";

// Domyślny zasięg szukania lokalu „w pobliżu" (m). Można zwiększać „szerszym zasięgiem".
const DEFAULT_NEARBY_RADIUS = 800;

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

const LANGUAGES = ["polski", "English", "Deutsch", "Español"];

export default function App() {
  const [tab, setTab] = useState<Tab>("scan");
  const [openScan, setOpenScan] = useState<SavedScan | null>(null);
  const [showDiag, setShowDiag] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  // Postęp analizy gdy skan idzie partiami (duże menu). null = brak/jedna partia.
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetLang, setTargetLang] = useState("polski");
  const [hint, setHint] = useState("");
  const [useDeviceLocation, setUseDeviceLocation] = useState(true);
  const [useExifLocation, setUseExifLocation] = useState(true);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);

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
    listScans().then(setScans).catch(() => {});
  }, []);

  function addImages(toAdd: PreparedImage[]) {
    if (toAdd.length === 0) return;
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

  async function doScan() {
    if (images.length === 0) return;
    setError(null);
    setStatus("scanning");
    try {
      // Źródła lokalizacji (oba opcjonalne):
      //  1) EXIF zdjęcia — najlepsze, bo wskazuje GDZIE zrobiono zdjęcie (lokal),
      //     działa nawet gdy skanujesz później.
      //  2) GPS urządzenia — pozycja użytkownika (kraj/miasto, też gdy nie w lokalu).
      let location: GeoPoint | null = null;
      let locationSource: LocationSource = null;

      if (useExifLocation) {
        const withGeo = images.find((i) => i.exifLocation);
        if (withGeo?.exifLocation) {
          location = withGeo.exifLocation;
          locationSource = "exif";
        }
      }
      if (!location && useDeviceLocation) {
        try {
          location = await getCurrentLocation();
          locationSource = "device";
        } catch {
          location = null; // brak zgody/błąd — skanujemy dalej bez lokalizacji
        }
      }
      // „Miasto, Kraj" z GPS → pewny kontekst dla modelu przy tłumaczeniu (gdzie jest lokal).
      const locationHint = location ? await reverseGeocode(location) : undefined;

      // Skan PARTIAMI: dużą liczbę zdjęć dzielimy na partie po SCAN_BATCH i scalamy
      // wyniki z deduplikacją (mniejsze, bezpieczne wywołania + widoczny postęp).
      const batches: PreparedImage[][] = [];
      for (let i = 0; i < images.length; i += SCAN_BATCH) batches.push(images.slice(i, i + SCAN_BATCH));

      let merged: Menu | null = null;
      let scanId: string | null = null;
      if (batches.length > 1) setScanProgress({ done: 0, total: images.length });

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi]!;
        // Dla kolejnych partii dajemy modelowi kontekst (nazwa/kuchnia) z dotychczasowego menu.
        const batchHint = merged
          ? [merged.restaurant_name, merged.cuisine].filter(Boolean).join(" ") || undefined
          : hint.trim() || undefined;
        const { menu: incoming, usage } = await scanMenu({
          images: batch.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
          targetLang,
          restaurantHint: batchHint,
          locationHint,
          model,
        });

        if (!merged) {
          // Pierwsza partia → bazowe menu + zapis (kolejne tylko dokładają).
          merged = incoming;
          if (hint.trim()) merged.restaurant_name = hint.trim(); // nazwa od usera ma pierwszeństwo
          const saved = await saveScan({
            menu: merged,
            targetLang,
            model,
            location,
            locationSource,
            useExifLocation,
            useDeviceLocation,
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
          setScanProgress({ done: Math.min((bi + 1) * SCAN_BATCH, images.length), total: images.length });
        }
        setScans(await listScans());
      }

      setScanProgress(null);
      setStatus("done");
      setVenueConfirmed(false); // pokaż krok potwierdzenia lokalu
      setVenueQuery("");
      const result = merged!;

      // Namierzenie lokalu: mamy nazwę → automatycznie po nazwie (pewne). Brak nazwy →
      // NIE zgadujemy po GPS automatycznie; ustawiamy tylko kontekst, a user kliknie.
      setFreshRestaurant(null);
      setRestaurantCtx({
        menu: result,
        location,
        scanId: scanId!,
        lang: targetLang,
        apply: setFreshRestaurant,
        applyMenu: setMenu,
        current: null,
        candidates: [],
      });
      if (result.restaurant_name) {
        void lookupRestaurant(result, location, scanId!, targetLang, setFreshRestaurant, {
          applyMenu: setMenu,
        });
      }

      // Tło, równolegle z automatu: (a) tanie zdjęcia poglądowe, (b) pełne opisy dań
      // (gotowe ad-hoc). Lepsze zdjęcia dociągają się dopiero przy wejściu w danie.
      void fillDishPhotos(result, scanId!, result.restaurant_name ?? undefined, setMenu);
      void fillDescriptions(result, scanId!, targetLang, model, setMenu);
    } catch (e) {
      setError(friendlyMessage(e instanceof Error ? e.message : undefined));
      setStatus("error");
      setScanProgress(null);
    }
  }

  function resetScan() {
    setImages([]);
    setMenu(null);
    setError(null);
    setStatus("idle");
    setFreshRestaurant(null);
    setFreshScanId(null);
    setRestaurantCtx(null);
    setVenueConfirmed(true);
    setVenueQuery("");
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
      void upgradeVenuePhotos(baseForUpgrade, scanId, cached, applyMenu);
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
    void upgradeVenuePhotos(baseForUpgrade, scanId, cached, applyMenu);
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

  async function loadInfo(opts: {
    menu: Menu;
    scanId: string | null;
    si: number;
    ii: number;
    targetLang: string;
    model: ModelId;
    taPhotos?: TripAdvisorPhoto[];
    photoHint?: string;
    location?: string;
    website?: string;
    applyMenu: (updater: (prev: Menu | null) => Menu | null) => void;
  }) {
    const item = opts.menu.sections[opts.si]?.items[opts.ii];
    if (!item) return;
    const { si, ii, scanId } = opts;
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
          model: opts.model,
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
        const realRes =
          matched.length > 0
            ? { photos: matched, usage: ZERO_USAGE }
            : await fetchDishPhotos(
                item.original,
                opts.photoHint ?? opts.menu.restaurant_name ?? undefined,
                {
                  cuisine: opts.menu.cuisine,
                  website: opts.website,
                  restaurantName: opts.menu.restaurant_name ?? undefined,
                },
              ).catch(() => ({ photos: [] as DishPhotoLite[], usage: ZERO_USAGE }));
        const real = realRes.photos;
        // Lepsze zdjęcia zastępują tanie tło; jak nic nie ma → oznacz, by nie szukać znów.
        const patch =
          real.length > 0
            ? { photos: await cachePhotos(real), photosUpgraded: true }
            : { photosUpgraded: true };
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
    const jobs: { si: number; ii: number; name: string }[] = [];
    baseMenu.sections.forEach((sec, si) =>
      sec.items.forEach((it, ii) => {
        if (it && !(it.photos && it.photos.length > 0)) jobs.push({ si, ii, name: it.original });
      }),
    );

    const CONCURRENCY = 4;
    let next = 0;
    let totalUsage: Usage = ZERO_USAGE;
    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (!job) break;
        const { photos, usage } = await fetchDishPhotos(job.name, undefined, {
          representativeOnly: true, // tanio: tylko Wikimedia/Openverse + weryfikacja
          cuisine: baseMenu.cuisine,
          num: 1,
        }).catch(() => ({ photos: [] as DishPhotoLite[], usage: ZERO_USAGE }));
        totalUsage = addUsage(totalUsage, usage);
        if (photos.length === 0) continue;
        const cached = await cachePhotos(photos); // pobierz na dysk (offline + brak rotacji linków)
        applyMenu((prev) => {
          if (!prev) return prev;
          const cur = prev.sections[job.si]?.items[job.ii];
          // Nie nadpisuj, jeśli user zdążył dostać LEPSZE zdjęcia z dotknięcia.
          if (cur?.photosUpgraded || (cur?.photos && cur.photos.length > 0)) return prev;
          return patchItem(prev, job.si, job.ii, { photos: cached });
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

    const { matches, usage } = await fetchVenuePhotos(
      photoNames,
      taPhotos,
      dishes,
      baseMenu.cuisine,
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
      applyMenu((prev) =>
        prev ? patchItem(prev, at.si, at.ii, { photos: cached, photosUpgraded: true }) : prev,
      );
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
    scanModel: ModelId,
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
          model: scanModel,
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
    scanModel: ModelId,
    scanLang: string,
    isOpen: boolean,
    newImages: PreparedImage[],
  ) {
    if (newImages.length === 0) return;
    setAppending(true);
    try {
      const hint = [baseMenu.restaurant_name, baseMenu.cuisine].filter(Boolean).join(" ") || undefined;
      const { menu: incoming, usage } = await scanMenu({
        images: newImages.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
        targetLang: scanLang,
        restaurantHint: hint,
        model: scanModel,
      });
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
      void fillDishPhotos(merged, scanId, merged.restaurant_name ?? undefined, applyMenu);
      void fillDescriptions(merged, scanId, scanLang, scanModel, applyMenu);
    } catch (e) {
      Alert.alert("Nie udało się dodać", friendlyMessage(e instanceof Error ? e.message : undefined));
    } finally {
      setAppending(false);
    }
  }

  // Wybór źródła nowych zdjęć (aparat / galeria), potem dołączenie do menu.
  function chooseAppendSource(
    scanId: string,
    baseMenu: Menu,
    scanModel: ModelId,
    scanLang: string,
    isOpen: boolean,
  ) {
    Alert.alert("Dodaj zdjęcia do menu", "Skąd dołączyć kolejne strony / zdjęcia menu?", [
      {
        text: "📷 Aparat",
        onPress: async () => {
          const img = await captureFromCamera();
          if (img) await appendImages(scanId, baseMenu, scanModel, scanLang, isOpen, [img]);
        },
      },
      {
        text: "🖼 Galeria",
        onPress: async () => {
          const imgs = await pickFromLibrary();
          if (imgs.length) await appendImages(scanId, baseMenu, scanModel, scanLang, isOpen, imgs);
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
        model,
        taPhotos: freshRestaurant?.tripAdvisor?.photos,
        photoHint: photoHintFor(menu, freshRestaurant),
        location: locationFor(menu, freshRestaurant),
        website: freshRestaurant?.website ?? undefined,
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
      model: openScan.model,
      taPhotos: openScan.restaurant?.tripAdvisor?.photos,
      photoHint: photoHintFor(openScan.menu, openScan.restaurant),
      location: locationFor(openScan.menu, openScan.restaurant),
      website: openScan.restaurant?.website ?? undefined,
      applyMenu: makeApplyMenu(openScan.id, true),
    });
  }

  const showingDetail = openScan !== null;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />

        <View style={styles.header}>
          <Text style={styles.brand}>MenuButBetter</Text>
          {showDiag || showingDetail ? (
            <Pressable
              onPress={() => (showDiag ? setShowDiag(false) : setOpenScan(null))}
              style={styles.navBtn}
            >
              <Text style={styles.navText}>‹ Wstecz</Text>
            </Pressable>
          ) : (
            <View style={styles.tabs}>
              <Pressable onPress={() => setTab("scan")}>
                <Text style={[styles.tab, tab === "scan" && styles.tabActive]}>Skanuj</Text>
              </Pressable>
              <Pressable onPress={() => setTab("history")}>
                <Text style={[styles.tab, tab === "history" && styles.tabActive]}>
                  Historia{scans.length ? ` (${scans.length})` : ""}
                </Text>
              </Pressable>
              <Pressable onPress={() => setShowDiag(true)} hitSlop={8}>
                <Text style={styles.tab}>📊</Text>
              </Pressable>
            </View>
          )}
        </View>

        {showDiag ? (
          <DiagnosticsView />
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
              <Pressable
                style={[styles.button, styles.secondary, appending && styles.disabled]}
                disabled={appending}
                onPress={() =>
                  chooseAppendSource(openScan.id, openScan.menu, openScan.model, openScan.targetLang, true)
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
                  <Text style={styles.intro}>
                    Dodaj zdjęcia menu — może być kilka stron i okładka. Połączę je w jedno
                    przetłumaczone menu, które zapiszę w historii.
                  </Text>

                  <Text style={styles.label}>Język tłumaczenia</Text>
                  <View style={styles.chipRow}>
                    {LANGUAGES.map((lang) => (
                      <Pressable
                        key={lang}
                        onPress={() => setTargetLang(lang)}
                        style={[styles.chip, targetLang === lang && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, targetLang === lang && styles.chipTextActive]}>
                          {lang}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  <Text style={styles.label}>Model AI</Text>
                  <View style={styles.modelRow}>
                    {MODEL_OPTIONS.map((m) => (
                      <Pressable
                        key={m.id}
                        onPress={() => setModel(m.id)}
                        style={[styles.modelCard, model === m.id && styles.modelCardActive]}
                      >
                        <Text style={[styles.modelLabel, model === m.id && styles.modelLabelActive]}>
                          {m.label}
                        </Text>
                        <Text style={[styles.modelHint, model === m.id && styles.modelHintActive]}>
                          {m.hint}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  <Text style={styles.label}>Lokal (opcjonalnie)</Text>
                  <TextInput
                    value={hint}
                    onChangeText={setHint}
                    placeholder="np. Trattoria da Marco, Florencja"
                    placeholderTextColor={colors.muted}
                    style={styles.input}
                  />

                  <Text style={styles.label}>Lokalizacja (pomaga namierzyć lokal)</Text>
                  <View style={styles.switchRow}>
                    <View style={styles.switchTextWrap}>
                      <Text style={styles.switchTitle}>📷 Z EXIF zdjęć</Text>
                      <Text style={styles.switchSub}>
                        Współrzędne zaszyte w zdjęciu (jeśli zrobione na miejscu). Działa też później.
                      </Text>
                    </View>
                    <Switch
                      value={useExifLocation}
                      onValueChange={setUseExifLocation}
                      trackColor={{ true: colors.accent }}
                    />
                  </View>
                  <View style={styles.switchRow}>
                    <View style={styles.switchTextWrap}>
                      <Text style={styles.switchTitle}>📍 Moja lokalizacja</Text>
                      <Text style={styles.switchSub}>
                        Pozycja GPS telefonu — pomaga ustalić kraj/miasto, też gdy nie jesteś w lokalu.
                      </Text>
                    </View>
                    <Switch
                      value={useDeviceLocation}
                      onValueChange={setUseDeviceLocation}
                      trackColor={{ true: colors.accent }}
                    />
                  </View>

                  {images.length > 0 ? (
                    <>
                      <Text style={styles.label}>
                        Zdjęcia ({images.length}/{MAX_IMAGES})
                      </Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
                        {images.map((img, i) => (
                          <View key={img.uri} style={styles.thumbWrap}>
                            <Image source={{ uri: img.uri }} style={styles.thumb} />
                            <Pressable style={styles.thumbRemove} onPress={() => removeImage(i)}>
                              <Text style={styles.thumbRemoveText}>×</Text>
                            </Pressable>
                            <Text style={styles.thumbIndex}>{i + 1}</Text>
                          </View>
                        ))}
                      </ScrollView>
                    </>
                  ) : null}

                  <View style={styles.addRow}>
                    <Pressable
                      style={[styles.addBtn, images.length >= MAX_IMAGES && styles.disabled]}
                      onPress={addFromCamera}
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

                  <Pressable
                    style={[styles.button, styles.primary, images.length === 0 && styles.disabled]}
                    onPress={doScan}
                    disabled={images.length === 0}
                  >
                    <Text style={styles.buttonText}>
                      {images.length === 0
                        ? "Dodaj zdjęcia, aby przetłumaczyć"
                        : `Przetłumacz menu (${images.length})`}
                    </Text>
                  </Pressable>

                  {error ? <Text style={styles.inlineError}>{error}</Text> : null}
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
                        chooseAppendSource(freshScanId, menu, model, targetLang, false)
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { fontSize: 22, fontWeight: "800", color: colors.accent },
  tabs: { flexDirection: "row", gap: 16 },
  tab: { fontSize: 15, fontWeight: "700", color: colors.muted },
  tabActive: { color: colors.accent, textDecorationLine: "underline" },
  navBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.badgeBg, borderRadius: 999 },
  navText: { color: colors.accent, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 48 },
  intro: { fontSize: 16, color: colors.text, lineHeight: 22, marginBottom: 24 },
  label: { fontSize: 13, fontWeight: "700", color: colors.muted, marginBottom: 8, marginTop: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.badgeBg },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: "600" },
  chipTextActive: { color: colors.buttonText },
  modelRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
  modelCard: {
    flex: 1,
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
  thumbRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
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
  center: { alignItems: "center", paddingVertical: 48 },
  scanning: { fontSize: 18, fontWeight: "700", color: colors.text, marginTop: 16, textAlign: "center" },
  scanningSub: { fontSize: 13, color: colors.muted, marginTop: 6, textAlign: "center" },
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
