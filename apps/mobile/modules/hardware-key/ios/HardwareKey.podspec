Pod::Spec.new do |s|
  s.name           = 'HardwareKey'
  s.version        = '1.0.0'
  s.summary        = 'md-runbook: the SSH key in the Secure Enclave'
  s.description    = 'Makes a P-256 key in the Secure Enclave (in the Keychain where there is none) and signs with it.'
  s.license        = 'MIT'
  s.author         = 'md-runbook'
  s.homepage       = 'https://github.com/smojon/md-runbook'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/smojon/md-runbook.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
