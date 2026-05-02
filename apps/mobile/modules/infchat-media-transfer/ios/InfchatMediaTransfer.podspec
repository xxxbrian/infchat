Pod::Spec.new do |s|
  s.name           = 'InfchatMediaTransfer'
  s.version        = '1.0.0'
  s.summary        = 'InfChat media transfer engine'
  s.description    = 'Native file upload helpers for InfChat media outbox transfers.'
  s.author         = 'InfChat'
  s.homepage       = 'https://infchat.app'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
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
