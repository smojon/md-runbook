Pod::Spec.new do |s|
  s.name           = 'BackgroundTime'
  s.version        = '1.0.0'
  s.summary        = 'md-runbook: finish a running cell in the background'
  s.description    = 'Asks iOS for background time while a cell runs, so switching apps for a moment does not cut its connection.'
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
