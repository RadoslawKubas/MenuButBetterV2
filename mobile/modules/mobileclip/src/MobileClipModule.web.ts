import { registerWebModule, NativeModule } from 'expo';

// MobileClipModule is not available on the web platform.
class MobileClipModule extends NativeModule<{}> {}

export default registerWebModule(MobileClipModule, 'MobileClipModule');
