Pod::Spec.new do |s|
  s.name           = 'MobileClip'
  s.version        = '1.0.0'
  s.summary        = 'On-device CLIP (Apple MobileCLIP S0) image-text dish matching'
  s.description    = 'MobileCLIP Core ML image+text encoders + CLIP tokenizer for photo-verification benchmark'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.5'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Modele Core ML (.mlpackage → kompilowane do .mlmodelc) + pliki tokenizera CLIP do bundla.
  s.resources = ["models/*.mlpackage", "models/tokenizer/vocab.json", "models/tokenizer/merges.txt"]
end
