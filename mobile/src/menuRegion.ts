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
export type MenuRegion = { box: MenuBox; quad: MenuQuad; frames: MenuBox[]; groups: MenuBox[]; medH: number; cols: number; rows: number; imgW: number; imgH: number; blocks: number };

// Sufit dłuższej krawędzi kafelka W PIKSELACH ORYGINAŁU — powyżej model i tak downscale'uje (tekst się robi
// nieczytelny). Trochę poniżej realnego sufitu vision (~1568), by zostawić zapas na zakładkę między kafelkami.
const TILE_MAX_PX = 1500;

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

type Fr = { left: number; top: number; width: number; height: number };
// Klastry stykających się ramek (connected-components, union-find) z progiem `gap` (piksele). Bbox per klaster.
function clusterPx(fr: Fr[], gap: number): Fr[] {
  const parent = fr.map((_, i) => i);
  const find = (i: number): number => { let x = i; while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const near = (a: Fr, b: Fr) => a.left <= b.left + b.width + gap && b.left <= a.left + a.width + gap && a.top <= b.top + b.height + gap && b.top <= a.top + a.height + gap;
  for (let i = 0; i < fr.length; i++) for (let j = i + 1; j < fr.length; j++) if (near(fr[i]!, fr[j]!)) parent[find(i)] = find(j);
  const byRoot = new Map<number, Fr[]>();
  for (let i = 0; i < fr.length; i++) { const r = find(i); let g = byRoot.get(r); if (!g) { g = []; byRoot.set(r, g); } g.push(fr[i]!); }
  return [...byRoot.values()].map((g) => {
    let l = Infinity, t = Infinity, r = -Infinity, btm = -Infinity;
    for (const f of g) { l = Math.min(l, f.left); t = Math.min(t, f.top); r = Math.max(r, f.left + f.width); btm = Math.max(btm, f.top + f.height); }
    return { left: l, top: t, width: r - l, height: btm - t };
  });
}
/** Przelicza GRUPY (klastry stykających się bloków) dla danego mnożnika progu — TANIO, bez ponownego OCR (do
 *  live-suwaka). gap = medianowa wys. linii × `mult`. Zwraca bbox-y grup ZNORMALIZOWANE. */
export function clusterGroups(region: MenuRegion, mult: number): MenuBox[] {
  const W = region.imgW, H = region.imgH;
  const fr: Fr[] = region.frames.map((f) => ({ left: f.x * W, top: f.y * H, width: f.w * W, height: f.h * H }));
  return clusterPx(fr, Math.max(1, region.medH * mult)).map((g) => ({ x: g.left / W, y: g.top / H, w: g.width / W, h: g.height / H }));
}

// SUROWY wynik OCR per zdjęcie — zapisywany do sampla, by eksperymentować z algorytmami w LABie (na komputerze),
// bez ponownego OCR na telefonie. Współrzędne ZNORMALIZOWANE 0..1 (+ w/h w px do ewentualnego przeliczenia).
export type OcrLine = { frame: MenuBox; corners: Pt[]; text: string };
export type OcrBlock = { frame: MenuBox; corners: Pt[]; text: string; lines: OcrLine[] };
export type OcrData = { w: number; h: number; blocks: OcrBlock[] };

/** Surowy OCR on-device (ML Kit) → bloki/linie z ramkami + cornerPoints + tekstem (znormalizowane). null = brak. */
export async function recognizeOcr(uri: string): Promise<OcrData | null> {
  const res = await TextRecognition.recognize(uri, TextRecognitionScript.LATIN);
  const { width, height } = await imageSize(uri);
  if (!width || !height) return null;
  const fr = (f?: { left: number; top: number; width: number; height: number } | null): MenuBox =>
    f ? { x: f.left / width, y: f.top / height, w: f.width / width, h: f.height / height } : { x: 0, y: 0, w: 0, h: 0 };
  const cp = (c?: readonly { x: number; y: number }[] | null): Pt[] => (c ?? []).map((p) => ({ x: p.x / width, y: p.y / height }));
  const blocks: OcrBlock[] = res.blocks.map((b) => ({
    frame: fr(b.frame), corners: cp(b.cornerPoints), text: b.text,
    lines: b.lines.map((l) => ({ frame: fr(l.frame), corners: cp(l.cornerPoints), text: l.text })),
  }));
  return { w: width, h: height, blocks };
}

/** OCR on-device → osiowy prostokąt + perspektywiczny czworokąt menu + proponowana siatka. null = brak tekstu. */
export async function detectMenuRegion(uri: string): Promise<MenuRegion | null> {
  const res = await TextRecognition.recognize(uri, TextRecognitionScript.LATIN);
  const { width, height } = await imageSize(uri);
  if (!width || !height) return null;

  // Zbierz ramki (osiowe) + narożniki SKOŚNE wszystkich linii (cornerPoints niosą perspektywę; brak → rogi ramki).
  const frames: Fr[] = [];
  const pts: Pt[] = []; // wszystkie narożniki tekstu, w pikselach
  const lineHeights: number[] = []; // do progu „bliskości" przy klastrowaniu
  let blocks = 0;
  for (const b of res.blocks) {
    if (b.frame && b.frame.width > 0 && b.frame.height > 0) { frames.push(b.frame); blocks++; }
    for (const line of b.lines) {
      if (line.frame?.height) lineHeights.push(line.frame.height);
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

  // KLASTRY stykających się bloków → osobne grupy zamiast JEDNEJ obwiedni (np. 2 kolumny / panele). Domyślny
  // mnożnik progu 1.2 (×medianowa wys. linii); na żywo strojony suwakiem przez clusterGroups (bez ponownego OCR).
  const medH = lineHeights.length ? lineHeights.slice().sort((a, b) => a - b)[Math.floor(lineHeights.length / 2)]! : (maxB - minT) * 0.05;
  const groups: MenuBox[] = clusterPx(frames, Math.max(1, medH * 1.2)).map((g) => ({ x: g.left / width, y: g.top / height, w: g.width / width, h: g.height / height }));

  return { box, quad, frames: framesN, groups, medH, cols, rows, imgW: width, imgH: height, blocks };
}
