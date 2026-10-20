Pod::Spec.new do |s|
  s.name           = 'DocumentAccess'
  s.version        = '1.0.0'
  s.summary        = 'md-runbook: open a runbook in place and save it back'
  s.description    = 'Opens a file with the document picker in place and keeps a security-scoped bookmark to read and write it later.'
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
