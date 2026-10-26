Pod::Spec.new do |s|
  s.name           = 'AppShortcuts'
  s.version        = '1.0.0'
  s.summary        = 'md-runbook: quick actions on the app icon'
  s.description    = 'The long-press menu of the app icon: Scan a code and the pinned runbooks.'
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
