import { registerWebModule, NativeModule } from 'expo';

// AppleVisionModule is not available on the web platform.
class AppleVisionModule extends NativeModule<{}> {}

export default registerWebModule(AppleVisionModule, 'AppleVisionModule');
