// Package sshsig checks a manifest's SSH signatures with OpenSSH's own `ssh-keygen -Y`, as the
// shell gate did: the gate never reads a key or a signature itself.
package sshsig

import (
	"bytes"
	"os"
	"os/exec"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Namespace of md-runbook signatures.
const Namespace = "md-runbook"

// Armor wraps a base64 SSHSIG blob as ssh-keygen writes it: 70 characters per line.
func Armor(b64 string) string {
	var b strings.Builder
	b.WriteString("-----BEGIN SSH SIGNATURE-----\n")
	for len(b64) > 70 {
		b.WriteString(b64[:70] + "\n")
		b64 = b64[70:]
	}
	b.WriteString(b64 + "\n")
	b.WriteString("-----END SSH SIGNATURE-----\n")
	return b.String()
}

// Verifier runs ssh-keygen.
type Verifier struct {
	// Keygen is the ssh-keygen to run ("ssh-keygen": found in the gate's PATH).
	Keygen string
	// AllowedSigners is the allowed_signers file.
	AllowedSigners string
	// Dir is where the signature files go (the session's work folder).
	Dir string
}

// Principal is the principal of the trusted key that made sig (base64) over message, "" when
// none did. One allowed_signers line may name several principals (a,b): each is tried.
func (v Verifier) Principal(message []byte, sig string) string {
	// A new file of a random name, created here (never through a link a cell planted).
	f, err := os.CreateTemp(v.Dir, "sig.")
	if err != nil {
		return ""
	}
	name := f.Name()
	defer os.Remove(name)
	_, err = f.WriteString(Armor(sig))
	if cerr := f.Close(); err != nil || cerr != nil {
		return ""
	}
	// (Whatever it prints counts, as in the shell gate: each name is verified below.)
	out, _ := exec.Command(v.keygen(), "-Y", "find-principals", "-s", name, "-f", v.AllowedSigners).Output()
	for _, p := range textutil.Fields(strings.ReplaceAll(string(out), ",", " ")) {
		cmd := exec.Command(v.keygen(), "-Y", "verify", "-f", v.AllowedSigners, "-I", p, "-n", Namespace, "-s", name)
		cmd.Stdin = bytes.NewReader(message)
		if cmd.Run() == nil {
			return p
		}
	}
	return ""
}

func (v Verifier) keygen() string {
	if v.Keygen != "" {
		return v.Keygen
	}
	return "ssh-keygen"
}
