// Wspólna nakładka rysująca wynik on-device OCR (menuRegion): zielony osiowy crop + bursztynowa siatka
// perspektywiczna (romby przy skosie). Używane i w Lightboxie (Migawki), i w aparacie (zamrożone zdjęcie),
// żeby kod rysowania był JEDEN. Mapuje znormalizowane punkty na wyświetlany (resizeMode contain) obraz
// w kontenerze boxW×boxH (z letterboxem). Linie bez SVG: każda to cienki obrócony View.
import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { clusterGroups, type MenuRegion, type MenuBox } from "./menuRegion";

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

export function MenuRegionOverlay({ region, boxW, boxH, groupMult, finalCrop }: { region: MenuRegion; boxW: number; boxH: number; groupMult?: number; finalCrop?: boolean }) {
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

  // KLASTRY stykających się bloków — każdy w innym kolorze (cyklicznie), żeby 2+ grup było rozróżnialnych.
  // groupMult (z suwaka) → przelicz grupy na żywo; brak → domyślne z detekcji.
  const groups: MenuBox[] = groupMult != null ? clusterGroups(region, groupMult) : region.groups;
  const GROUP_COLORS = ["#e879f9", "#22d3ee", "#fb7185", "#c084fc", "#2dd4bf"];
  const groupRects = groups.map((g, i) => {
    const col = GROUP_COLORS[i % GROUP_COLORS.length]!;
    return <View key={`g${i}`} pointerEvents="none" style={{ position: "absolute", left: offX + g.x * dW, top: offY + g.y * dH, width: g.w * dW, height: g.h * dH, borderWidth: 2, borderColor: col, backgroundColor: col + "22", borderRadius: 3 }} />;
  });

  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: boxW, height: boxH }}>
      {frameRects}
      {finalCrop ? (
        // FINALNY KADR do modelu (dokładnie ten `box` wycinamy w compress) — biały przerywany, bez wypełnienia,
        // z etykietą, żeby od razu było widać CO zostanie wysłane do modelu.
        <>
          <View pointerEvents="none" style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderWidth: 2.5, borderColor: "#fff", borderStyle: "dashed" }} />
          <View pointerEvents="none" style={{ position: "absolute", left: rect.left, top: Math.max(0, rect.top - 17), backgroundColor: "rgba(0,0,0,0.62)", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
            <Text style={{ color: "#fff", fontSize: 9, fontWeight: "800" }}>kadr do modelu</Text>
          </View>
        </>
      ) : (
        <View style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderWidth: 2.5, borderColor: "#4ade80", backgroundColor: "rgba(74,222,128,0.12)", borderRadius: 3 }} />
      )}
      {groupRects}
      {lines}
    </View>
  );
}
