#!/usr/bin/env bash
# Szybki build + instalacja apki na SYMULATOR iOS — do testowania BEZ TestFlight.
#
# Użycie:
#   cd mobile && ./build-sim.sh           DEV build (debug) — szybkie iteracje, WYMAGA Metro (skrypt sam odpala)
#   RELEASE=1 ./build-sim.sh              RELEASE build — JS WBUDOWANY w .app, ZERO Metro (klikasz kiedy chcesz, jak TestFlight)
#   SIM_UDID=<udid> ./build-sim.sh        inny symulator
#   EXPO_PUBLIC_API_URL=http://192.168.x.y:8787 ./build-sim.sh   lokalny serwer
#
# PUŁAPKA (rozwiązana niżej): Ruby 4.0 + CocoaPods 1.16 wywala `pod install` błędem
# „Unicode Normalization not appropriate for ASCII-8BIT" gdy locale NIE jest UTF-8.
# Dlatego wymuszamy LANG/LC_ALL=en_US.UTF-8.
set -uo pipefail
cd "$(dirname "$0")"

DEV="${SIM_UDID:-C538D998-8566-4683-89A7-46A7CBCD8709}"   # iPhone 17 Pro (zmień przez SIM_UDID)
API="${EXPO_PUBLIC_API_URL:-https://menubutbetter-production.up.railway.app}"
TOKEN="${EXPO_PUBLIC_APP_TOKEN:-$(cd ../server && railway run printenv APP_TOKEN 2>/dev/null | tail -1)}"
BUNDLE="com.appwithkiss.menubutbetter.lab"
RELEASE="${RELEASE:-0}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # ← fix CocoaPods/Ruby ASCII-8BIT
export EXPO_PUBLIC_API_URL="$API" EXPO_PUBLIC_APP_TOKEN="$TOKEN"

echo "▸ Symulator: $DEV · API: $API · tryb: $([ "$RELEASE" = 1 ] && echo RELEASE || echo DEV)"
xcrun simctl boot "$DEV" 2>/dev/null || true
open -a Simulator

if [ "$RELEASE" = 1 ]; then
  # ── RELEASE: JS wbudowany w binarkę (faza „Bundle React Native code" w Xcode).
  #    Po tym apka jest SAMODZIELNA — odpalasz ikonką kiedy chcesz, Metro NIEpotrzebne.
  npx expo run:ios --configuration Release --device "$DEV" \
    || echo "  (auto-launch expo padł — odpalam ręcznie niżej)"
  xcrun simctl launch "$DEV" "$BUNDLE" 2>/dev/null || true
  echo "✓ RELEASE na symulatorze. Standalone — żadne Metro nie jest potrzebne."
  exit 0
fi

# ── DEV (debug dev-client): JS serwuje Metro. Bez Metro = czerwony ekran
#    „No script URL provided". Dlatego PILNUJEMY, by Metro chodziło.
npx expo run:ios --device "$DEV" \
  || echo "  (auto-launch expo padł — odpalam ręcznie niżej)"

# Metro: odpal w tle, jeśli nie chodzi na 8081, i poczekaj aż wstanie.
if ! curl -s -m 2 http://localhost:8081/status 2>/dev/null | grep -qi packager; then
  echo "▸ Metro nie chodzi — odpalam w tle…"
  nohup npx expo start --port 8081 >/tmp/menubb-metro.log 2>&1 &
  for i in $(seq 1 20); do
    curl -s -m 2 http://localhost:8081/status 2>/dev/null | grep -qi packager && break
    sleep 1
  done
fi

# Launch przez deep-link = wskazujemy dev-clientowi adres Metro (inaczej startuje z null URL).
xcrun simctl terminate "$DEV" "$BUNDLE" 2>/dev/null || true
sleep 1
xcrun simctl openurl "$DEV" "$BUNDLE://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" 2>/dev/null || true
echo "✓ DEV na symulatorze. Czerwony ekran 'No script URL' = Metro padło → './build-sim.sh' znów albo 'npx expo start' (log: /tmp/menubb-metro.log)."
echo "  Chcesz klikać kiedy chcesz BEZ Metro? → 'RELEASE=1 ./build-sim.sh'"
