// Normalizacja języka docelowego do KODU ISO 639-1 (np. „polski" → „pl") — DO KLUCZY CACHE. Język pochodzi
// z listy wyboru w apce (kontrolowane, nie z AI), ale jako czytelna nazwa. W kluczu trzymamy stabilny kod
// (krótki, język-niezależny), a w PROMPCIE do modelu zostaje czytelna nazwa (model pisze w tym języku).
const LANG_TO_ISO: Record<string, string> = {
  polski: "pl", polish: "pl",
  english: "en", angielski: "en",
  deutsch: "de", niemiecki: "de", german: "de",
  espanol: "es", hiszpanski: "es", spanish: "es",
  francais: "fr", francuski: "fr", french: "fr",
  italiano: "it", wloski: "it", italian: "it",
  portugues: "pt", portugalski: "pt", portuguese: "pt",
  nederlands: "nl", niderlandzki: "nl", dutch: "nl",
  ukrainski: "uk", ukrainian: "uk",
  rosyjski: "ru", russian: "ru",
};

/** Kod ISO języka dla klucza cache. Już-kod (2 litery) przepuszczamy; nieznane → znormalizowana nazwa
 *  (stabilna, deterministyczna — lepsze to niż wywalenie się). */
export function langCode(name: string | undefined | null): string {
  if (!name) return "";
  const n = name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/^[a-z]{2}$/.test(n)) return n;
  return LANG_TO_ISO[n] ?? n;
}
