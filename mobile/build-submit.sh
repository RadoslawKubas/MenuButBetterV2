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

# Konto Apple z góry (zamiast pytania „Apple ID?" / „to konto?"). Sam e-mail nie jest sekretem.
export EXPO_APPLE_ID="rk@appwithkiss.com"
# Opcjonalnie hasło app-specific (do auto-auth, GDY trzeba odświeżyć poświadczenia) — trzymaj
# je w NIEśledzonym pliku mobile/.apple-secrets:  export EXPO_APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
# (wygeneruj na https://appleid.apple.com → Sign-In and Security → App-Specific Passwords)
# shellcheck disable=SC1091
[ -f .apple-secrets ] && source .apple-secrets

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
# --non-interactive działa, bo w eas.json jest submit.production.ios.ascAppId
# (6782273577 = apka LAB, bundle com.appwithkiss.menubutbetter.lab) → eas pomija krok
# „ensure app exists", który logował się do Apple (2FA). Submit przechodzi w tle, bez 2FA.
eas submit --platform ios --profile production --path "$IPA" --non-interactive

echo "✓ Gotowe — $IPA wysłany. Apple przetworzy build za ~5–10 min (dostaniesz maila)."
