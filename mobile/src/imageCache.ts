// Lokalny cache obrazków na telefonie — żeby historia działała offline i nie zależała
// od (wygasających) linków z portali. Trzymamy w katalogu document (trwały, system go
// nie kasuje). Nazwa pliku = hash URL-a, więc te same zdjęcia dzielą jeden plik.
//
// WAŻNE: zapisujemy ścieżkę WZGLĘDNĄ ("dishphotos/<hash>"), a bezwzględny `file://`
// składamy dopiero przy renderze (resolveCachedUri). Na iOS bazowy katalog kontenera
// (…/Containers/Data/Application/<UUID>/…) zmienia się między uruchomieniami/aktualizacjami
// aplikacji, więc zapisany na stałe bezwzględny URI po restarcie wskazuje w pustkę.
import { Directory, File, Paths } from "expo-file-system";
import type { DishPhotoLite } from "./types";

const DIR = new Directory(Paths.document, "dishphotos");

function ensureDir(): void {
  if (!DIR.exists) DIR.create({ intermediates: true, idempotent: true });
}

// Deterministyczny hash (djb2) URL-a → krótka, bezpieczna nazwa pliku.
function hashName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) + url.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(36)}.img`;
}

// Czy `uri` jest już naszą lokalną referencją (względną albo starą bezwzględną).
function isLocalRef(uri: string): boolean {
  return uri.startsWith("dishphotos/") || uri.includes("/dishphotos/") || uri.startsWith("file://");
}

/**
 * Pobiera obrazek na dysk i zwraca WZGLĘDNĄ ścieżkę cache ("dishphotos/<hash>").
 * Pomija już-lokalne. Przy błędzie (brak sieci, padły format) zwraca oryginalny URL
 * — nigdy nie wywala wywołującego.
 */
export async function cacheImage(remoteUrl: string): Promise<string> {
  if (!remoteUrl || isLocalRef(remoteUrl)) return remoteUrl;
  try {
    ensureDir();
    const name = hashName(remoteUrl);
    const rel = `dishphotos/${name}`;
    const dest = new File(DIR, name);
    if (dest.exists) return rel; // już pobrane wcześniej
    await File.downloadFileAsync(remoteUrl, dest, { idempotent: true });
    return rel;
  } catch {
    return remoteUrl; // graceful — zostaje zdalny URL
  }
}

/**
 * Składa bezwzględny `file://` URI z zapisanej referencji cache — przy KAŻDYM renderze
 * (bo bazowy katalog kontenera potrafi się zmienić). Działa dla nowej ścieżki względnej
 * "dishphotos/<hash>" ORAZ dla starych, zapisanych ścieżek bezwzględnych (wyłuskuje nazwę
 * po ostatnim "dishphotos/"). Zdalne URL-e (http) zwraca bez zmian.
 */
export function resolveCachedUri(stored?: string): string | undefined {
  if (!stored) return stored;
  const m = stored.match(/dishphotos\/([^/?#]+)$/);
  if (m) return new File(DIR, m[1]).uri;
  return stored;
}

/** Pobiera lokalnie wszystkie zdjęcia dania; `url` = referencja cache, `remoteUrl` = źródło. */
export async function cachePhotos(photos: DishPhotoLite[]): Promise<DishPhotoLite[]> {
  return Promise.all(
    photos.map(async (p) => {
      const local = await cacheImage(p.url);
      if (local === p.url) return p; // nic nie pobrano (już lokalne lub błąd)
      return { ...p, url: local, remoteUrl: p.remoteUrl ?? p.url };
    }),
  );
}
