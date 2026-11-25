//go:build unix

package gate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
)

// The certificate fixtures of internal/sshcert (see its test for how they were made).
const (
	certCA    = "SHA256:8dS7sj3mTs7we6rVDfvRba5W1zuVeM0PwxbfLOfBS7c"
	certAlice = "SHA256:lq96FEEJbMFUKPOV5ZWPHvOIb0rTtA6mSw6OVq1ZawY"
)

func fixtureKey(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "sshcert", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(data))
	return f[0] + " " + f[1]
}

// ExposeAuthInfo's file: the first publickey line counts, whatever other methods came first.
func TestAuthKey(t *testing.T) {
	dir := t.TempDir()
	auth := filepath.Join(dir, "auth")
	cert := fixtureKey(t, "ed25519-cert.pub")
	other := fixtureKey(t, "ed25519.pub")
	os.WriteFile(auth, []byte("keyboard-interactive\npublickey "+cert+"\npublickey "+other+"\n"), 0o600)
	if got := authKey(auth); got != cert {
		t.Errorf("authKey: %q", got)
	}
	os.WriteFile(auth, []byte("password\n"), 0o600)
	if got := authKey(auth); got != "" {
		t.Errorf("no publickey line: %q", got)
	}
	if got := authKey(filepath.Join(dir, "none")); got != "" {
		t.Errorf("no file: %q", got)
	}
}

// who for each kind of login, and what the session event adds.
func TestIdentifyKey(t *testing.T) {
	keygen, _ := exec.LookPath("ssh-keygen")
	for _, c := range []struct {
		name, key, who string
		wantWho        string
		wantLog        []string
		problem        string
	}{
		{name: "a certificate", key: fixtureKey(t, "ed25519-cert.pub"),
			wantWho: "alice@example", wantLog: []string{"key", certAlice, "cert_serial", "42", "cert_ca", certCA}},
		{name: "a certificate with --who=", key: fixtureKey(t, "ed25519-cert.pub"), who: "Ops Team",
			wantWho: "Ops Team", wantLog: []string{"key", certAlice, "cert_serial", "42", "cert_ca", certCA}},
		{name: "a key ID with a line break", key: fixtureKey(t, "ed25519-nl-cert.pub"),
			wantWho: certAlice, wantLog: []string{"key", certAlice, "cert_serial", "9", "cert_ca", certCA}, problem: "key ID with a control or invisible character (U+000A)"},
		{name: "a certificate with sshd's note", key: fixtureKey(t, "ed25519-cert.pub") + " signature count = 3",
			wantWho: "alice@example", wantLog: []string{"key", certAlice, "cert_serial", "42", "cert_ca", certCA}},
		{name: "no key", key: ""},
	} {
		g := &Gate{who: c.who, helpers: map[string]string{"ssh-keygen": keygen}}
		g.identifyKey(c.key)
		want := c.wantLog
		if c.problem != "" {
			want = append(append([]string(nil), want...), "cert_problem", c.problem)
		}
		if g.who != c.wantWho || !reflect.DeepEqual(g.certLog(), want) {
			t.Errorf("%s: who %q, log %q; want %q, %q", c.name, g.who, g.certLog(), c.wantWho, want)
		}
		// One valid JSON line, whatever the key ID was.
		l := &logx.Logger{Account: "ops", Who: g.who}
		line := l.Line(append([]string{"event", "session"}, g.certLog()...)...)
		if !json.Valid([]byte(line)) || strings.ContainsAny(line, "\n\r") {
			t.Errorf("%s: not one JSON line: %s", c.name, line)
		}
	}

	// A plain key: its fingerprint, as ssh-keygen -l prints it; nothing more in the session event.
	// A host certificate (sshd never takes one for a login): read as before, with a note.
	for _, c := range []struct {
		name, key, problem string
	}{
		{"a plain key", fixtureKey(t, "ed25519.pub"), ""},
		{"a host certificate", fixtureKey(t, "ed25519-host-cert.pub"), "certificate: not a user certificate (type 2)"},
	} {
		g := &Gate{helpers: map[string]string{"ssh-keygen": keygen}}
		g.identifyKey(c.key)
		want := ""
		if keygen != "" {
			want = certAlice
		}
		var wantLog []string
		if c.problem != "" {
			wantLog = []string{"cert_problem", c.problem}
		}
		if g.who != want || g.cert != nil || !reflect.DeepEqual(g.certLog(), wantLog) {
			t.Errorf("%s: who %q, cert %v, log %q", c.name, g.who, g.cert, g.certLog())
		}
	}
}
