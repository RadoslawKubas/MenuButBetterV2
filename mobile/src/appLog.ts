// Klient: lekki log wywołań NASZEGO API (do ekranu „Diagnostyka") + powiadomienie o błędach
// (toast), żeby przy testach od razu było widać, gdy coś poleciało — nawet jeśli niekrytyczne.
export interface ClientCall {
  ts: number;
  label: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const MAX = 60;
const calls: ClientCall[] = [];
type Listener = (e: ClientCall) => void;
const errorListeners = new Set<Listener>();

export function logCall(e: ClientCall): void {
  calls.unshift(e);
  if (calls.length > MAX) calls.length = MAX;
  if (!e.ok) errorListeners.forEach((l) => l(e));
}

export function getCalls(): ClientCall[] {
  return calls.slice();
}

/** Subskrypcja BŁĘDÓW (do toasta). Zwraca funkcję odsubskrybowania. */
export function onApiError(l: Listener): () => void {
  errorListeners.add(l);
  return () => {
    errorListeners.delete(l);
  };
}

export interface ErrorKind {
  icon: string;
  label: string;
  color: string;
}

/** Klasyfikacja błędu po treści (status HTTP + słowa kluczowe) — do ikon/etykiet. */
export function classifyError(detail?: string): ErrorKind {
  const d = (detail ?? "").toLowerCase();
  const status = Number((d.match(/http (\d{3})/) ?? [])[1] ?? 0);
  const has = (...k: string[]) => k.some((x) => d.includes(x));
  const RED = "#b3261e";
  const AMBER = "#c77700";

  if (has("credit", "insufficient", "balance", "quota", "exhaust", "billing", "payment"))
    return { icon: "💳", label: "Kredyty / limit konta", color: RED };
  if (status === 401 || status === 403 || has("unauthorized", "forbidden", "authentication", "api key", "api_key", "permission", "invalid key"))
    return { icon: "🔑", label: "Autoryzacja / klucz", color: RED };
  if (status === 429 || has("rate limit", "rate_limit", "too many", "overloaded"))
    return { icon: "⏳", label: "Limit zapytań (rate)", color: AMBER };
  if (status >= 500 || has("internal server", "server error", "bad gateway", "unavailable"))
    return { icon: "🔥", label: "Błąd serwera", color: RED };
  if (status === 404 || has("not found"))
    return { icon: "🔎", label: "Nie znaleziono", color: AMBER };
  if (status === 400 || has("bad request", "invalid request", "invalid argument"))
    return { icon: "⚠️", label: "Złe zapytanie", color: AMBER };
  if (has("network", "timeout", "timed out", "fetch failed", "abort", "econn", "enotfound", "socket", "tls"))
    return { icon: "🔌", label: "Sieć / timeout", color: AMBER };
  return { icon: "❗", label: "Błąd", color: RED };
}

/** Czytelny komunikat dla użytkownika (zamiast surowego/„Nieznany błąd"). */
export function friendlyMessage(detail?: string): string {
  switch (classifyError(detail).label) {
    case "Sieć / timeout":
      return "Problem z połączeniem. Sprawdź internet i spróbuj ponownie.";
    case "Limit zapytań (rate)":
      return "Za dużo zapytań na raz. Odczekaj chwilę i spróbuj ponownie.";
    case "Kredyty / limit konta":
      return "Wyczerpany limit/kredyty jednego z API. Zajrzyj do Diagnostyki (📊).";
    case "Autoryzacja / klucz":
      return "Problem z autoryzacją API. Sprawdź klucze w Diagnostyce (📊).";
    case "Błąd serwera":
      return "Chwilowy błąd serwera. Spróbuj ponownie za moment.";
    default:
      return detail && detail.length > 0 && detail.length < 120
        ? detail
        : "Coś poszło nie tak. Spróbuj ponownie.";
  }
}
