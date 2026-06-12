// Lokalny cache obrazków na telefonie — żeby historia działała offline i nie zależała
// od (wygasających) linków z portali. Trzymamy w katalogu document (trwały, system go
// nie kasuje). Nazwa pliku = hash URL-a, więc te same zdjęcia dzielą jeden plik.
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

/**
 * Pobiera obrazek na dysk i zwraca lokalny `file://` URI.
 * Pomija już-lokalne. Przy błędzie (brak sieci, padły format) zwraca oryginalny URL
 * — nigdy nie wywala wywołującego.
 */
export async function cacheImage(remoteUrl: string): Promise<string> {
  if (!remoteUrl || remoteUrl.startsWith("file://")) return remoteUrl;
  try {
    ensureDir();
    const dest = new File(DIR, hashName(remoteUrl));
    if (dest.exists) return dest.uri; // już pobrane wcześniej
    const file = await File.downloadFileAsync(remoteUrl, dest, { idempotent: true });
    return file.uri;
  } catch {
    return remoteUrl; // graceful — zostaje zdalny URL
  }
}

/** Pobiera lokalnie wszystkie zdjęcia dania; `url` wskazuje na plik, `remoteUrl` = źródło. */
export async function cachePhotos(photos: DishPhotoLite[]): Promise<DishPhotoLite[]> {
  return Promise.all(
    photos.map(async (p) => {
      const local = await cacheImage(p.url);
      if (local === p.url) return p; // nic nie pobrano (już lokalne lub błąd)
      return { ...p, url: local, remoteUrl: p.remoteUrl ?? p.url };
    }),
  );
}
