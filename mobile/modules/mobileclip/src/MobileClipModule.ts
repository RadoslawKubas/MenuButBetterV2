import { NativeModule, requireNativeModule } from 'expo';

declare class MobileClipModuleType extends NativeModule<Record<string, never>> {
  /** Podobieństwo CLIP zdjęcie↔tekst. score = cosine (~ -0.1..0.35). null = niedostępne/błąd. */
  match(url: string, text: string): Promise<{ score: number } | null>;
  /** Zero-shot: zdjęcie vs wiele etykiet → cosine per etykieta (embed obrazu liczony RAZ). */
  classify(url: string, labels: string[]): Promise<{ scores: { label: string; score: number }[] } | null>;
  /** Embedding obrazu (do podobieństwa obraz↔obraz, np. dedup). */
  embed(url: string): Promise<{ embedding: number[] } | null>;
  /** Diagnostyka: co się załadowało (modele/tokenizer) — do debugu, czemu CLIP nie liczy. */
  diag(): Promise<Record<string, unknown>>;
}

export default requireNativeModule<MobileClipModuleType>('MobileClip');
