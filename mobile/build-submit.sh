#!/usr/bin/env bash
# Lokalny build iOS (bez kredytów chmury EAS) + wysyłka świeżego .ipa na TestFlight.
#
# Użycie:  cd mobile && ./build-submit.sh
#
# Jak działa:
#  1. Kasuje stare build-*.ipa, żeby nie wysłać przypadkiem starego (zużyty numer).
#  2. eas build --local — przy appVersionSource:remote + autoIncrement numer builda
#     sam rośnie i jest wpiekany w .ipa.
#  3. Bierze jedyny powstały build-*.ipa i wysyła go (eas submit).
set -euo pipefail

cd "$(dirname "$0")" # katalog mobile/

echo "▸ Sprzątam stare .ipa…"
rm -f build-*.ipa

echo "▸ Buduję lokalnie (numer builda podbije się sam)…"
# --non-interactive: użyje zapisanych poświadczeń (cert + provisioning na serwerze Expo),
# bez pytań. Gdyby zabrakło poświadczeń, usuń tę flagę i odpal raz interaktywnie.
eas build --local --platform ios --profile production --non-interactive

# Świeży artefakt = jedyny build-*.ipa (po rm został tylko ten nowy).
IPA="$(ls -t build-*.ipa 2>/dev/null | head -1 || true)"
if [ -z "$IPA" ]; then
  echo "✗ Nie znalazłem .ipa — build się nie powiódł. Sprawdź log wyżej."
  exit 1
fi

echo "▸ Wysyłam na TestFlight: $IPA"
eas submit --platform ios --profile production --path "$IPA" --non-interactive

echo "✓ Gotowe — $IPA wysłany. Apple przetworzy build za ~5–10 min (dostaniesz maila)."
