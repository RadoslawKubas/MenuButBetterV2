import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { View } from 'react-native';

import App from './App';
import { BuildBadge } from './src/BuildBadge';

// Owijamy App globalnym overlayem z numerem builda (BuildBadge) — widoczny na KAŻDYM ekranie, niezależnie od
// nawigacji. createElement zamiast JSX, by index został .ts. App zachowuje własne providery (renderuje się w środku).
function Root() {
  return createElement(View, { style: { flex: 1 } }, createElement(App), createElement(BuildBadge));
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => Root);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
