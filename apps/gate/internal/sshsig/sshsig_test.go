package sshsig

import (
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestArmor(t *testing.T) {
	sig := strings.Repeat("A", 70) + strings.Repeat("B", 70) + "CC"
	want := "-----BEGIN SSH SIGNATURE-----\n" + strings.Repeat("A", 70) + "\n" + strings.Repeat("B", 70) + "\nCC\n-----END SSH SIGNATURE-----\n"
	if got := Armor(sig); got != want {
		t.Errorf("Armor:\n%s", got)
	}
	if got := Armor(strings.Repeat("A", 70)); got != "-----BEGIN SSH SIGNATURE-----\n"+strings.Repeat("A", 70)+"\n-----END SSH SIGNATURE-----\n" {
		t.Errorf("Armor of 70:\n%s", got)
	}
}

// With the real ssh-keygen: a signature of a trusted key verifies (each principal of its line is
// tried), a changed message, a stranger's key and another namespace don't.
func TestPrincipal(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("no ssh-keygen")
	}
	dir := t.TempDir()
	gen := func(name, comment string) string {
		k := filepath.Join(dir, name)
		if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", k).CombinedOutput(); err != nil {
			t.Fatalf("keygen: %v %s", err, out)
		}
		return k
	}
	signer, stranger := gen("signer", "ops@example.net"), gen("stranger", "x")
	pub, err := os.ReadFile(signer + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(pub))
	allowed := filepath.Join(dir, "allowed_signers")
	if err := os.WriteFile(allowed, []byte(`ops@example.net,release@example.net namespaces="md-runbook" `+f[0]+" "+f[1]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sign := func(key, ns string, msg []byte) string {
		cmd := exec.Command("ssh-keygen", "-Y", "sign", "-f", key, "-n", ns, "-q")
		cmd.Stdin = bytes.NewReader(msg)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		// The blob, base64 on one line, as the app sends it.
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		blob, err := base64.StdEncoding.DecodeString(strings.Join(lines[1:len(lines)-1], ""))
		if err != nil {
			t.Fatal(err)
		}
		return base64.StdEncoding.EncodeToString(blob)
	}
	msg := []byte("md-runbook-manifest 1\nname ops/test\nversion 1\nend\n")
	v := Verifier{AllowedSigners: allowed, Dir: dir}
	if p := v.Principal(msg, sign(signer, Namespace, msg)); p != "ops@example.net" {
		t.Errorf("principal = %q", p)
	}
	if p := v.Principal([]byte("md-runbook-manifest 1\nname ops/test\nversion 2\nend\n"), sign(signer, Namespace, msg)); p != "" {
		t.Errorf("changed message: %q", p)
	}
	if p := v.Principal(msg, sign(stranger, Namespace, msg)); p != "" {
		t.Errorf("stranger: %q", p)
	}
	if p := v.Principal(msg, sign(signer, "file", msg)); p != "" {
		t.Errorf("other namespace: %q", p)
	}
	if p := v.Principal(msg, "bm90IGEgc2lnbmF0dXJl"); p != "" {
		t.Errorf("garbage: %q", p)
	}
	// No signature file is left behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "sig.") {
			t.Errorf("left %s", e.Name())
		}
	}
}
