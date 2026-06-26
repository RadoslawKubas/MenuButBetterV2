// ON-DEVICE wykrywanie prostokąta MENU (lista dań) — lokalne AI telefonu, ZERO chmury. Używa ML Kit Text
// Recognition (OCR Google na urządzeniu): rozpoznaje bloki tekstu i ich ramki, a my składamy z nich jeden
// prostokąt obejmujący cały tekst (karta dań = gęsty tekst). Wynik znormalizowany 0..1 → rysowany na podglądzie.
// To NA RAZIE TYLKO podgląd (zaznaczenie graficzne); fizyczny crop do modelu dorobimy, jeśli ramki będą dobre.
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { Image } from "react-native";

export type MenuBox = { x: number; y: number; w: number; h: number };
export type MenuRegion = { box: MenuBox; imgW: number; imgH: number; blocks: number };

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
}

/** OCR on-device → prostokąt obejmujący wykryty tekst (lista dań), znormalizowany 0..1. null = nie znaleziono tekstu. */
export async function detectMenuRegion(uri: string): Promise<MenuRegion | null> {
  const res = await TextRecognition.recognize(uri, TextRecognitionScript.LATIN);
  const frames = res.blocks.map((b) => b.frame).filter((f): f is NonNullable<typeof f> => !!f && f.width > 0 && f.height > 0);
  if (!frames.length) return null;
  const { width, height } = await imageSize(uri);
  if (!width || !height) return null;
  // Union ramek wszystkich bloków tekstu = obszar menu.
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const f of frames) {
    minL = Math.min(minL, f.left);
    minT = Math.min(minT, f.top);
    maxR = Math.max(maxR, f.left + f.width);
    maxB = Math.max(maxB, f.top + f.height);
  }
  // Mały margines wokół tekstu + clamp do 0..1.
  const padX = width * 0.015, padY = height * 0.01;
  const x = Math.max(0, (minL - padX) / width);
  const y = Math.max(0, (minT - padY) / height);
  const w = Math.min(1 - x, (maxR + padX) / width - x);
  const h = Math.min(1 - y, (maxB + padY) / height - y);
  return { box: { x, y, w, h }, imgW: width, imgH: height, blocks: frames.length };
}
