// Package names holds the environment names the gate refuses or removes.
package names

import "strings"

// ReservedExact and ReservedPrefixes: names a parameter or env.* value may not set. They change
// how the shell or the programs it starts read the signed code, or where they connect. Signing
// refuses the same names (core's RESERVED_VARS and RESERVED_VAR_PREFIXES; test/gate.test.ts
// compares the two lists). Not KUBECONFIG: env.KUBECONFIG picks the cluster, and is signed.
//
// (Keep one quoted name after another between the braces: the test reads these lists as text.)
var ReservedExact = []string{
	"PATH", "IFS", "ENV", "BASH_ENV", "CDPATH", "GLOBIGNORE", "HOME", "SHELL", "SHELLOPTS", "BASHOPTS", "PS1", "PS2", "PS3", "PS4",
	"PROMPT_COMMAND", "PWD", "OLDPWD", "TMPDIR", "BASH_COMPAT", "BASH_XTRACEFD", "HISTFILE",
	"LANG", "LANGUAGE", "GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES",
	"NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS",
	"GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
	"http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CURL_HOME", "CURL_CA_BUNDLE",
	"XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
	"GIT_EXEC_PATH", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXTERNAL_DIFF", "JDK_JAVA_OPTIONS", "OPENSSL_CONF",
	"LUA_INIT", "PERLLIB", "PHPRC", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "HOSTALIASES", "PAGER", "LESSOPEN", "LESSCLOSE",
	"KUBECTL_EXTERNAL_DIFF", "ftp_proxy", "FTP_PROXY", "EDITOR", "VISUAL", "BROWSER",
}

// ReservedPrefixes: see ReservedExact.
var ReservedPrefixes = []string{
	"LC_", "LD_", "DYLD_", "BASH_FUNC_", "__mdrb_", "MD_RUNBOOK_GATE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_",
}

var reserved = func() map[string]bool {
	m := make(map[string]bool, len(ReservedExact))
	for _, n := range ReservedExact {
		m[n] = true
	}
	return m
}()

// IsReserved: a name a runbook may not set. And any name ending in _proxy, in any case: Python's
// urllib (pip, requests) reads Https_Proxy and FOO_proxy as proxies (as core's isReservedVar;
// gate vectors, 2026-11-16).
func IsReserved(name string) bool {
	if reserved[name] {
		return true
	}
	for _, p := range ReservedPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return len(name) >= 6 && strings.EqualFold(name[len(name)-6:], "_proxy")
}

// Unsafe: names removed from the gate's own environment at its start. Nothing that changes how
// the programs it starts (ssh-keygen, getent, locale) load code, read files or connect. sshd
// passes what a key line's environment= and ~/.ssh/environment set (with PermitUserEnvironment
// yes), and the names AcceptEnv lets the client send (security review round 4). The gate refuses
// environment= and ~/.ssh/environment as well; this is for the rest. (The blocks' shell gets
// the names in CellsEnv only.) GODEBUG: the Go runtime's settings for TLS and X.509, among others
// (unset at the start, the packages read the defaults again).
func Unsafe(name string) bool {
	switch name {
	case "BASH_ENV", "ENV", "CDPATH", "GLOBIGNORE", "SHELLOPTS", "BASHOPTS", "PS4",
		"GCONV_PATH", "LOCPATH", "NLSPATH", "GLIBC_TUNABLES",
		"HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", "AWKPATH", "AWKLIBPATH", "PERLLIB", "NODE_OPTIONS",
		"SSH_SK_PROVIDER", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "KUBECONFIG",
		"LANG", "LANGUAGE", "GODEBUG":
		return true
	}
	for _, p := range []string{"LD_", "DYLD_", "CURL_", "SSL_", "OPENSSL_", "MALLOC_", "PERL5", "PYTHON", "LC_"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return strings.HasSuffix(name, "_proxy") || strings.HasSuffix(name, "_PROXY")
}

// CellsEnv: the gate's own environment the cells' shell gets, these names only (security review
// round 3). Not what sshd's environment= or ~/.ssh/environment may add (proxies, NODE_OPTIONS,
// KUBECONFIG). SHELL, PATH, LANG and KUBECONFIG are the gate's (gate.conf).
var CellsEnv = []string{"HOME", "USER", "LOGNAME", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "TERM", "TZ", "TMPDIR"}
