// Spójne ikony WEKTOROWE (iOS / Android / symulator) ZAMIAST emoji — emoji renderowały się jako „tofu" na
// symulatorze (brak fontu Apple Color Emoji) i są niespójne między platformami. Klucz = funkcja, wartość = glif
// MaterialCommunityIcons (zweryfikowane, że istnieją). Używać w JSX, też wewnątrz <Text> (renderuje się jak glif).
import React from "react";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { StyleProp, TextStyle } from "react-native";
import { colors } from "./theme";

const MAP = {
  camera: "camera",
  gallery: "image-multiple",
  image: "image",
  photo: "camera",
  settings: "cog",
  location: "map-marker",
  search: "magnify",
  searchAlt: "feature-search",
  home: "home",
  venue: "storefront",
  cost: "cash",
  money: "currency-usd",
  euro: "currency-eur",
  spend: "cash-minus",
  upload: "tray-arrow-up",
  download: "tray-arrow-down",
  inbox: "inbox-arrow-down",
  cloud: "cloud-outline",
  edit: "pencil",
  web: "web",
  globe: "earth",
  delete: "delete-outline",
  note: "note-text-outline",
  city: "city",
  phone: "phone",
  device: "cellphone",
  dot: "circle",
  calendar: "calendar",
  plus: "plus",
  refresh: "refresh",
  book: "book-open-variant",
  tag: "tag-outline",
  flask: "flask-outline",
  owl: "owl",
  map: "map-outline",
  close: "close",
  bug: "bug-outline",
  clock: "clock-outline",
  flashlight: "flashlight",
  party: "party-popper",
  signal: "access-point",
  check: "check",
  cache: "database-outline",
  chartBar: "chart-bar",
  chartLine: "chart-line",
  laptop: "laptop",
  robot: "robot-outline",
  food: "silverware-fork-knife",
  cancel: "cancel",
  block: "block-helper",
  vegan: "sprout-outline",
  veg: "carrot",
  spicy: "chili-mild",
  diamond: "rhombus-medium",
  ticket: "ticket-outline",
  receipt: "receipt",
  file: "file-document-outline",
  package: "package-variant",
  calculator: "calculator",
  numeric: "numeric",
  link: "link-variant",
  warn: "alert-outline",
  hourglass: "timer-sand",
  star: "star",
  starOutline: "star-outline",
  help: "help-circle-outline",
  info: "information-outline",
  back: "arrow-left",
  forward: "arrow-right",
  fire: "fire",
} as const;

export type IconName = keyof typeof MAP;

/** Pojedyncza ikona. `color` domyślnie akcent (większość użyć); nadpisz dla białego tekstu / wyciszonego.
 *  Wewnątrz <Text> osadza się jak glif — można wstawiać inline z tekstem. */
export function Icon({ name, size = 15, color = colors.accent, style }: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return <MaterialCommunityIcons name={MAP[name]} size={size} color={color} style={style} />;
}

/* ŚCIĄGA emoji → name (do spójnych podmian):
   📷📸 camera/photo · 🖼 image · galeria→gallery · ⚙ settings · 📍 location · 🔍 search · 🔎 searchAlt
   🏠 home/venue · 💰 cost · 💲 money · 💶 euro · 💸 spend · ⬆📤 upload · ⬇📥 download/inbox · ☁ cloud
   ✏ edit · 🌐 web · 🌍 globe · 🗑 delete · 📝 note · 🏙 city · 📞 phone · 📱 device · 🟢🔴⚪ dot(+color)
   📅🗓 calendar · ➕ plus · 🔄🔁🔂 refresh · 📖 book · 🏷 tag · 🧪 flask · 🦉 owl · 🗺 map · ❌✕ close
   🐛 bug · 🕒🕘⏰⏱ clock · 🔦 flashlight · 🎉 party · 📡 signal · ✅ check · 🗄 cache · 📊 chartBar · 📈 chartLine
   💻 laptop · 🤖 robot · 🍝 food · ⛔🚫 cancel/block · 🌱 vegan · 🥕 veg · 🌶 spicy · 🔸 diamond · 🎫 ticket
   🧾 receipt · 📄 file · 📦 package · 🧮 calculator · 🔢 numeric · 🔗 link · ⚠ warn · ⏳ hourglass · ★ star */
