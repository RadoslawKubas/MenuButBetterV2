// Etykieta + kolor źródła zdjęcia (pasek na miniaturce). Kategorie ustawia serwer
// (photoSourceCategory): restaurant / tripadvisor / yelp / zomato / thefork / foursquare /
// social / wikimedia / openverse / web.
// `short` = mikro-etykieta na cienki pasek małej miniaturki.
export function sourceMeta(source?: string): { label: string; short: string; color: string } {
  switch (source) {
    case "restaurant":
      return { label: "Strona lokalu", short: "LOKAL", color: "#b8860b" }; // złoty
    case "google":
      return { label: "Google Maps", short: "GOOGLE", color: "#4285f4" };
    case "tripadvisor":
      return { label: "TripAdvisor", short: "TRIPADV.", color: "#00a680" };
    case "yelp":
      return { label: "Yelp", short: "YELP", color: "#d32323" };
    case "zomato":
      return { label: "Zomato", short: "ZOMATO", color: "#e23744" };
    case "thefork":
      return { label: "TheFork", short: "FORK", color: "#00665e" };
    case "foursquare":
      return { label: "Foursquare", short: "4SQ", color: "#f94877" };
    case "social":
      return { label: "Social", short: "SOCIAL", color: "#3b5998" };
    case "wikimedia":
      return { label: "Wikimedia", short: "WIKI", color: "#7c6f64" };
    case "openverse":
      return { label: "Openverse", short: "OPENV.", color: "#7c6f64" };
    case "web":
      return { label: "Sieć", short: "SIEĆ", color: "#2563eb" };
    default:
      return { label: "Zdjęcie", short: "FOTO", color: "#6b7280" };
  }
}
