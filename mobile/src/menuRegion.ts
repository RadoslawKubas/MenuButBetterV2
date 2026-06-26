// ON-DEVICE analiza układu MENU — lokalne AI telefonu (ML Kit Text Recognition, OCR Google, ZERO chmury).
// Z bloków/linii tekstu wyciągamy DWIE rzeczy:
//  • `box`  — prostokąt OSIOWY obejmujący tekst (crop „do modelu": mniej marginesów = lepsza rozdzielczość).
//  • `quad` — CZWOROKĄT perspektywiczny (z `cornerPoints` linii) → uwzględnia krzywą perspektywę (menu pstryknięte
//    pod kątem to romb/trapez, nie prostokąt). Na nim rysujemy siatkę kafelków (rombów), nie prostą kratę.
//  • `cols`/`rows` — proponowana siatka kafelków, tak by każdy kafelek mieścił się w suficie modelu (duże menu‑ściany
//    → więcej kafelków → każdy fragment w pełnej rozdzielczości). TEST: na razie tylko podgląd, bez cięcia/wysyłki.
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { Image } from "react-native";

export type Pt = { x: number; y: number }; // znormalizowane 0..1 względem zdjęcia
export type MenuBox = { x: number; y: number; w: number; h: number };
export type MenuQuad = { tl: Pt; tr: Pt; br: Pt; bl: Pt };
export type MenuRegion = { box: MenuBox; quad: MenuQuad; frames: MenuBox[]; cols: number; rows: number; imgW: number; imgH: number; blocks: number };

// Sufit dłuższej krawędzi kafelka W PIKSELACH ORYGINAŁU — powyżej model i tak downscale'uje (tekst się robi
// nieczytelny). Trochę poniżej realnego sufitu vision (~1568), by zostawić zapas na zakładkę między kafelkami.
const TILE_MAX_PX = 1500;

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** OCR on-device → osiowy prostokąt + perspektywiczny czworokąt menu + proponowana siatka. null = brak tekstu. */
export async function detectMenuRegion(uri: string): Promise<MenuRegion | null> {
  const res = await TextRecognition.recognize(uri, TextRecognitionScript.LATIN);
  const { width, height } = await imageSize(uri);
  if (!width || !height) return null;

  // Zbierz ramki (osiowe) + narożniki SKOŚNE wszystkich linii (cornerPoints niosą perspektywę; brak → rogi ramki).
  const frames: { left: number; top: number; width: number; height: number }[] = [];
  const pts: Pt[] = []; // wszystkie narożniki tekstu, w pikselach
  let blocks = 0;
  for (const b of res.blocks) {
    if (b.frame && b.frame.width > 0 && b.frame.height > 0) { frames.push(b.frame); blocks++; }
    for (const line of b.lines) {
      if (line.cornerPoints) for (const p of line.cornerPoints) pts.push({ x: p.x, y: p.y });
      else if (line.frame) { const f = line.frame; pts.push({ x: f.left, y: f.top }, { x: f.left + f.width, y: f.top }, { x: f.left + f.width, y: f.top + f.height }, { x: f.left, y: f.top + f.height }); }
    }
  }
  if (!frames.length || !pts.length) return null;

  // box: union ramek osiowych + mały margines (crop).
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const f of frames) { minL = Math.min(minL, f.left); minT = Math.min(minT, f.top); maxR = Math.max(maxR, f.left + f.width); maxB = Math.max(maxB, f.top + f.height); }
  const padX = width * 0.015, padY = height * 0.01;
  const bx = Math.max(0, (minL - padX) / width), by = Math.max(0, (minT - padY) / height);
  const box: MenuBox = { x: bx, y: by, w: Math.min(1 - bx, (maxR + padX) / width - bx), h: Math.min(1 - by, (maxB + padY) / height - by) };

  // quad: ORIENTED BOUNDING BOX — odporny czworokąt idący za SKOSEM menu. NIE wymaga tekstu w rogach (menu często
  // ma puste rogi / wyśrodkowany tytuł), więc nie „ucieka" jak metoda 4 skrajnych punktów. Kąt = MEDIANA kątów
  // górnych krawędzi linii (cornerPoints[0]→[1]) — odporna na pojedyncze przekrzywione linie. Obracamy punkty o
  // −kąt wokół centroidu, liczymy bbox (z lekkim przycięciem 1% outlierów), rogi obracamy z powrotem o +kąt.
  const angles: number[] = [];
  for (const b of res.blocks) for (const line of b.lines) {
    const cp = line.cornerPoints;
    if (cp && cp.length >= 2) { const a = Math.atan2(cp[1]!.y - cp[0]!.y, cp[1]!.x - cp[0]!.x); if (Number.isFinite(a)) angles.push(a); }
  }
  const angle = angles.length ? angles.slice().sort((a, b) => a - b)[Math.floor(angles.length / 2)]! : 0;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const rot = (p: Pt, ang: number): Pt => { const c = Math.cos(ang), s = Math.sin(ang), dx = p.x - cx, dy = p.y - cy; return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }; };
  const rpts = pts.map((p) => rot(p, -angle));
  const xs = rpts.map((p) => p.x).sort((a, b) => a - b);
  const ys = rpts.map((p) => p.y).sort((a, b) => a - b);
  const at = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * t)))]!;
  const minX = at(xs, 0.01), maxX = at(xs, 0.99), minY = at(ys, 0.01), maxY = at(ys, 0.99); // przytnij 1% skrajnych
  const tlP = rot({ x: minX, y: minY }, angle), trP = rot({ x: maxX, y: minY }, angle), brP = rot({ x: maxX, y: maxY }, angle), blP = rot({ x: minX, y: maxY }, angle);
  const norm = (p: Pt): Pt => ({ x: p.x / width, y: p.y / height });
  const quad: MenuQuad = { tl: norm(tlP), tr: norm(trP), br: norm(brP), bl: norm(blP) };

  // Siatka: ile kafelków, by każdy ≤ sufit. Z DŁUGOŚCI krawędzi OBB (w pikselach), bierzemy dłuższą parę.
  const wPx = Math.max(dist(tlP, trP), dist(blP, brP));
  const hPx = Math.max(dist(tlP, blP), dist(trP, brP));
  const cols = Math.max(1, Math.ceil(wPx / TILE_MAX_PX));
  const rows = Math.max(1, Math.ceil(hPx / TILE_MAX_PX));

  // Indywidualne ramki bloków OCR (znormalizowane) — do podglądu „co dostajemy" (niebieskie).
  const framesN: MenuBox[] = frames.map((f) => ({ x: f.left / width, y: f.top / height, w: f.width / width, h: f.height / height }));
  return { box, quad, frames: framesN, cols, rows, imgW: width, imgH: height, blocks };
}
