// Wspólna nakładka rysująca wynik on-device OCR (menuRegion): zielony osiowy crop + bursztynowa siatka
// perspektywiczna (romby przy skosie). Używane i w Lightboxie (Migawki), i w aparacie (zamrożone zdjęcie),
// żeby kod rysowania był JEDEN. Mapuje znormalizowane punkty na wyświetlany (resizeMode contain) obraz
// w kontenerze boxW×boxH (z letterboxem). Linie bez SVG: każda to cienki obrócony View.
import { type ReactNode } from "react";
import { View } from "react-native";
import type { MenuRegion } from "./menuRegion";

function GridLine({ a, b, bold }: { a: { x: number; y: number }; b: { x: number; y: number }; bold?: boolean }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const th = bold ? 2.5 : 1.5;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - th / 2,
        width: len,
        height: th,
        backgroundColor: bold ? "rgba(251,191,36,0.95)" : "rgba(251,191,36,0.5)",
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

export function MenuRegionOverlay({ region, boxW, boxH }: { region: MenuRegion; boxW: number; boxH: number }) {
  const scale = Math.min(boxW / region.imgW, boxH / region.imgH);
  const dW = region.imgW * scale, dH = region.imgH * scale;
  const offX = (boxW - dW) / 2, offY = (boxH - dH) / 2;
  const toDisp = (p: { x: number; y: number }) => ({ x: offX + p.x * dW, y: offY + p.y * dH });
  const lerp = (A: { x: number; y: number }, B: { x: number; y: number }, t: number) => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });

  // Osiowy crop (zielony) — proste przycięcie marginesów.
  const rect = { left: offX + region.box.x * dW, top: offY + region.box.y * dH, width: region.box.w * dW, height: region.box.h * dH };
  // Perspektywiczny czworokąt + siatka kafelków (bursztyn): krawędzie grube, podziały cienkie. Segmenty proste → romby przy skosie.
  const TL = toDisp(region.quad.tl), TR = toDisp(region.quad.tr), BR = toDisp(region.quad.br), BL = toDisp(region.quad.bl);
  const lines: ReactNode[] = [];
  for (let i = 0; i <= region.cols; i++) { const t = i / region.cols; lines.push(<GridLine key={`v${i}`} a={lerp(TL, TR, t)} b={lerp(BL, BR, t)} bold={i === 0 || i === region.cols} />); }
  for (let j = 0; j <= region.rows; j++) { const t = j / region.rows; lines.push(<GridLine key={`h${j}`} a={lerp(TL, BL, t)} b={lerp(TR, BR, t)} bold={j === 0 || j === region.rows} />); }

  // Niebieskie: KAŻDA ramka bloku OCR osobno („co dostajemy" — zielony union to ich obwiednia).
  const frameRects = region.frames.map((f, i) => (
    <View key={`f${i}`} pointerEvents="none" style={{ position: "absolute", left: offX + f.x * dW, top: offY + f.y * dH, width: f.w * dW, height: f.h * dH, borderWidth: 1, borderColor: "rgba(96,165,250,0.85)", backgroundColor: "rgba(96,165,250,0.07)", borderRadius: 1 }} />
  ));

  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: boxW, height: boxH }}>
      {frameRects}
      <View style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderWidth: 2.5, borderColor: "#4ade80", backgroundColor: "rgba(74,222,128,0.12)", borderRadius: 3 }} />
      {lines}
    </View>
  );
}
