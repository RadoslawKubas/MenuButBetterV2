Pod::Spec.new do |s|
  s.name           = 'AppleVision'
  s.version        = '1.0.0'
  s.summary        = 'On-device dish-photo verifier (Apple Vision)'
  s.description    = 'VNClassifyImageRequest + image aesthetics for photo verification benchmark'
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
end
