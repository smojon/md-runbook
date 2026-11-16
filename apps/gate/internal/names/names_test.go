package names

import "testing"

func TestIsReserved(t *testing.T) {
	for _, n := range []string{"PATH", "IFS", "NODE_OPTIONS", "https_proxy", "GIT_ASKPASS", "EDITOR", "ftp_proxy", "LC_ALL", "LD_PRELOAD", "BASH_FUNC_x%%", "__mdrb_c", "MD_RUNBOOK_GATE_RUN", "GIT_CONFIG_KEY_0", "Https_Proxy", "FOO_proxy", "socks_PROXY"} {
		if !IsReserved(n) {
			t.Errorf("%s is not reserved", n)
		}
	}
	for _, n := range []string{"KUBECONFIG", "TARGET", "GREETING", "path", "LANGUAGES_X", "PROXY", "X_PROXYX"} {
		if IsReserved(n) {
			t.Errorf("%s is reserved", n)
		}
	}
}

func TestUnsafe(t *testing.T) {
	for _, n := range []string{"LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "http_proxy", "HTTPS_PROXY", "CURL_HOME", "SSL_CERT_FILE", "PYTHONPATH", "PERL5LIB", "LC_ALL", "LANG", "KUBECONFIG", "GODEBUG", "MALLOC_CHECK_", "SSH_AUTH_SOCK"} {
		if !Unsafe(n) {
			t.Errorf("%s is kept", n)
		}
	}
	for _, n := range []string{"HOME", "USER", "TZ", "TMPDIR", "SSH_CLIENT", "SSH_CONNECTION", "SSH_ORIGINAL_COMMAND", "SSH_USER_AUTH", "PATH", "TERM"} {
		if Unsafe(n) {
			t.Errorf("%s is removed", n)
		}
	}
}
