import { NativeModule, requireNativeModule } from 'expo';

export interface AppleVisionLabel { text: string; confidence: number }
export interface AppleVisionResult {
  labels: AppleVisionLabel[];
  /** iOS 18+: ogólna estetyka -1..1 (brak na <18). */
  aesthetics?: number;
  /** iOS 18+: true = grafika/dokument/screenshot/logo (raczej NIE zdjęcie dania). */
  isUtility?: boolean;
}

declare class AppleVisionModuleType extends NativeModule<Record<string, never>> {
  /** Analiza zdjęcia (remote URL pobierany natywnie). null = nie udało się pobrać/zdekodować. */
  analyze(url: string): Promise<AppleVisionResult | null>;
}

export default requireNativeModule<AppleVisionModuleType>('AppleVision');
