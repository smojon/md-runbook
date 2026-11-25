package sshcert

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The fixtures in testdata were made with ssh-keygen (OpenSSH 9.7p1):
//
//	ssh-keygen -t ed25519 -f ca; ssh-keygen -t ecdsa -b 384 -f ca-ecdsa
//	ssh-keygen -s ca -I alice@example -n ops -z 42 -V 20260101:20360101 ed25519.pub
//	ssh-keygen -s ca-ecdsa -I 'Bob Builder' -n ops,oncall -z 18446744073709551615 -V 20260101:20360101 ecdsa.pub
//	ssh-keygen -s ca -I carol@example -n ops -z 7 -O clear -O force-command=/usr/local/bin/md-runbook-gate rsa.pub
//	ssh-keygen -s ca -h -I host.example -n host.example -z 3 ed25519-host.pub
//	ssh-keygen -s ca -I "$(printf 'mallory\n{"who":"alice"}')" -n ops -z 9 ed25519-nl.pub
//
// The fingerprints are ssh-keygen -l's of ca.pub, ca-ecdsa.pub and the plain keys.
const (
	caED25519 = "SHA256:8dS7sj3mTs7we6rVDfvRba5W1zuVeM0PwxbfLOfBS7c"
	caECDSA   = "SHA256:hXxD5nbWtkFb6dV5hlIROSqL7Cq1lXxRkTdgKglm7YY"
	keyAlice  = "SHA256:lq96FEEJbMFUKPOV5ZWPHvOIb0rTtA6mSw6OVq1ZawY"
	keyBob    = "SHA256:P8Xk/3grHQmwUeIXp1Zl1fZYc8dVFLcMmNKA3t1z9ws"
	keyCarol  = "SHA256:o9M5jcQFgf58rWI4/mTBk6DE5HH3TkJL93KpMiFA4vU"
)

func readLine(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func blobOf(t *testing.T, line string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(strings.Fields(line)[1])
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFixtures(t *testing.T) {
	for _, c := range []struct {
		file string
		want Cert
	}{
		{"ed25519-cert.pub", Cert{Type: "ssh-ed25519-cert-v01@openssh.com", KeyID: "alice@example", Serial: 42, Key: keyAlice, CA: caED25519, Principals: []string{"ops"}}},
		{"ecdsa-cert.pub", Cert{Type: "ecdsa-sha2-nistp256-cert-v01@openssh.com", KeyID: "Bob Builder", Serial: 18446744073709551615, Key: keyBob, CA: caECDSA, Principals: []string{"ops", "oncall"}}},
		{"rsa-cert.pub", Cert{Type: "ssh-rsa-cert-v01@openssh.com", KeyID: "carol@example", Serial: 7, Key: keyCarol, CA: caED25519, Principals: []string{"ops"}}},
		{"ed25519-nl-cert.pub", Cert{Type: "ssh-ed25519-cert-v01@openssh.com", KeyID: "mallory\n{\"who\":\"alice\"}", Serial: 9, Key: keyAlice, CA: caED25519, Principals: []string{"ops"}}},
	} {
		// As ExposeAuthInfo writes it after "publickey ": type and base64, then maybe sshd's notes.
		line := readLine(t, c.file)
		f := strings.Fields(line)
		for _, l := range []string{f[0] + " " + f[1], f[0] + " " + f[1] + " signature count = 3"} {
			got, err := FromAuthLine(l)
			if err != nil {
				t.Fatalf("%s: %v", c.file, err)
			}
			if !reflect.DeepEqual(*got, c.want) {
				t.Errorf("%s:\n got %+v\nwant %+v", c.file, *got, c.want)
			}
		}
	}
}

// The same values as ssh-keygen -L prints them, where ssh-keygen is.
func TestAgainstKeygen(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen")
	}
	for _, file := range []string{"ed25519-cert.pub", "ecdsa-cert.pub", "rsa-cert.pub"} {
		out, err := exec.Command(keygen, "-L", "-f", filepath.Join("testdata", file)).Output()
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		c, err := FromAuthLine(readLine(t, file))
		if err != nil {
			t.Fatal(err)
		}
		text := strings.ReplaceAll(string(out), "\r\n", "\n")
		for _, want := range []string{
			"Public key: ",
			"-CERT " + c.Key + "\n",
			"Signing CA: ",
			" " + c.CA + " ",
			"Key ID: \"" + c.KeyID + "\"\n",
			"Serial: " + strconv.FormatUint(c.Serial, 10) + "\n",
		} {
			if !strings.Contains(text, want) {
				t.Errorf("%s: ssh-keygen -L doesn't say %q:\n%s", file, want, text)
			}
		}
	}
}

func TestNotACert(t *testing.T) {
	plain := readLine(t, "ed25519.pub")
	for _, l := range []string{plain, "", "ssh-ed25519", "publickey"} {
		if _, err := FromAuthLine(l); !errors.Is(err, ErrNotCert) {
			t.Errorf("%q: %v, want ErrNotCert", l, err)
		}
	}
}

func TestRefused(t *testing.T) {
	cert := readLine(t, "ed25519-cert.pub")
	f := strings.Fields(cert)
	blob := blobOf(t, cert)
	bad := map[string]string{
		"a host certificate":   strings.Join(strings.Fields(readLine(t, "ed25519-host-cert.pub"))[:2], " "),
		"another type":         "ssh-rsa-cert-v01@openssh.com " + f[1],
		"an unknown type":      "ssh-xmss-cert-v01@openssh.com " + f[1],
		"bad base64":           f[0] + " " + f[1][:len(f[1])-3] + "!!!",
		"a byte after the end": f[0] + " " + base64.StdEncoding.EncodeToString(append(append([]byte(nil), blob...), 0)),
	}
	for what, l := range bad {
		if _, err := FromAuthLine(l); err == nil || errors.Is(err, ErrNotCert) {
			t.Errorf("%s: %v, want an error", what, err)
		}
	}
	// Every shorter blob is an error, never a panic.
	for n := 0; n < len(blob); n++ {
		if _, err := Parse(blob[:n]); err == nil {
			t.Fatalf("%d of %d bytes: no error", n, len(blob))
		}
	}
	// A string length past the end, and one near 2^32.
	huge := append(sshString([]byte("ssh-ed25519-cert-v01@openssh.com")), 0xff, 0xff, 0xff, 0xf0)
	if _, err := Parse(huge); err == nil {
		t.Error("a huge length: no error")
	}
}

// A security-key certificate (no fixture: ssh-keygen needs the key's hardware to make one): its
// key's fingerprint covers the application too, as in its plain key.
func TestSecurityKeyLayout(t *testing.T) {
	str := func(s string) []byte { return sshString([]byte(s)) }
	u64 := func(v uint64) []byte { b := make([]byte, 8); binary.BigEndian.PutUint64(b, v); return b }
	u32 := func(v uint32) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, v); return b }
	pk := strings.Repeat("k", 32)
	ca := append(str("ssh-ed25519"), str(strings.Repeat("c", 32))...)
	var blob []byte
	for _, part := range [][]byte{
		str("sk-ssh-ed25519-cert-v01@openssh.com"), str("nonce"), str(pk), str("ssh:"),
		u64(5), u32(1), str("dave@example"), sshString(append(str("ops"), str("dev")...)),
		u64(0), u64(^uint64(0)), str(""), str(""), str(""), sshString(ca), str("sig"),
	} {
		blob = append(blob, part...)
	}
	c, err := Parse(blob)
	if err != nil {
		t.Fatal(err)
	}
	wantKey := Fingerprint(append(append(str("sk-ssh-ed25519@openssh.com"), str(pk)...), str("ssh:")...))
	want := Cert{Type: "sk-ssh-ed25519-cert-v01@openssh.com", KeyID: "dave@example", Serial: 5, Key: wantKey, CA: Fingerprint(ca), Principals: []string{"ops", "dev"}}
	if !reflect.DeepEqual(*c, want) {
		t.Errorf("\n got %+v\nwant %+v", *c, want)
	}
}

func TestName(t *testing.T) {
	ok := []string{"alice@example", "Bob Builder", "vault-oidc-alice-0123abcd", "Zoë", strings.Repeat("a", MaxKeyID), `quote" back\slash`}
	for _, id := range ok {
		if name, problem := Name(id); name != id || problem != "" {
			t.Errorf("%q: %q %q", id, name, problem)
		}
	}
	bad := []string{
		"", strings.Repeat("a", MaxKeyID+1), "a\nb", "a\rb", "a\tb", "a\x00b", "a\x1bb", "a\x7fb",
		"a\u0085b", // C1 control (NEL)
		"a\u202eb", // right-to-left override
		"a\u200bb", // zero-width space
		"a\u2028b", // line separator
		"a\u00a0b", // no-break space
		"a\ufffdb", // replacement character
		"a\ue000b", // private use
		"a\xffb",   // not UTF-8
		" alice", "alice ",
	}
	for _, id := range bad {
		if name, problem := Name(id); name != "" || problem == "" {
			t.Errorf("%q: accepted as %q", id, name)
		}
	}
}
