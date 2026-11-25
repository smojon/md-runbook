// Package sshcert reads the OpenSSH user certificate a login used, as sshd's ExposeAuthInfo file
// names it: who the certificate says the person is (its key ID), its serial and its CA.
//
// It checks nothing about trust. sshd already did, before the login: the CA (TrustedUserCAKeys
// or a cert-authority line), the signature, the validity, the principals and RevokedKeys. The key
// ID is the CA's text, so Name checks it before the gate logs it.
//
// The layout is OpenSSH's (draft-miller-ssh-cert, now draft-ietf-sshm-cert; the security-key
// types in OpenSSH's PROTOCOL.u2f): string type, string nonce, the key's own fields, uint64
// serial, uint32 type (1: user), string key ID, string principals, uint64 valid after, uint64
// valid before, string critical options, string extensions, string reserved, string signature
// key, string signature.
package sshcert

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxKeyID is the longest key ID the gate logs as who (bytes).
const MaxKeyID = 256

// Cert is what the gate logs of a user certificate.
type Cert struct {
	// Type is the certificate's type, e.g. ssh-ed25519-cert-v01@openssh.com.
	Type string
	// KeyID is the certificate's key ID as the CA wrote it: check it with Name before use.
	KeyID string
	// Serial is the certificate's serial number.
	Serial uint64
	// Key is the fingerprint of the certificate's plain key (SHA256:..., as ssh-keygen -l
	// prints it): what the gate logged as who before it read certificates.
	Key string
	// CA is the fingerprint of the key that signed the certificate.
	CA string
	// Principals are the certificate's principals.
	Principals []string
}

// The certificate types sshd accepts, by type: the plain key's type, and the number of key
// fields (each a string or an mpint, which is encoded as a string) after the nonce.
var keyTypes = map[string]struct {
	plain  string
	fields int
}{
	"ssh-rsa-cert-v01@openssh.com":                {"ssh-rsa", 2},                            // e, n
	"ssh-dss-cert-v01@openssh.com":                {"ssh-dss", 4},                            // p, q, g, y
	"ecdsa-sha2-nistp256-cert-v01@openssh.com":    {"ecdsa-sha2-nistp256", 2},                // curve, Q
	"ecdsa-sha2-nistp384-cert-v01@openssh.com":    {"ecdsa-sha2-nistp384", 2},                // curve, Q
	"ecdsa-sha2-nistp521-cert-v01@openssh.com":    {"ecdsa-sha2-nistp521", 2},                // curve, Q
	"ssh-ed25519-cert-v01@openssh.com":            {"ssh-ed25519", 1},                        // pk
	"sk-ecdsa-sha2-nistp256-cert-v01@openssh.com": {"sk-ecdsa-sha2-nistp256@openssh.com", 3}, // curve, Q, application
	"sk-ssh-ed25519-cert-v01@openssh.com":         {"sk-ssh-ed25519@openssh.com", 2},         // pk, application
}

// IsCertType reports whether an SSH key type is a certificate's (known to this package or not).
func IsCertType(t string) bool { return strings.Contains(t, "-cert-") }

// ErrNotCert: the key isn't a certificate.
var ErrNotCert = errors.New("not a certificate")

// FromAuthLine reads the key of an ExposeAuthInfo line without its method: "TYPE BASE64
// [more]" (sshkey_format_text, then sshd's notes, e.g. a security key's signature count).
// ErrNotCert for a plain key; another error for a certificate it can't read.
func FromAuthLine(key string) (*Cert, error) {
	f := strings.Fields(key)
	if len(f) < 2 || !IsCertType(f[0]) {
		return nil, ErrNotCert
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil {
		return nil, errors.New("certificate: bad base64")
	}
	c, err := Parse(blob)
	if err != nil {
		return nil, err
	}
	if c.Type != f[0] {
		return nil, errors.New("certificate: the line's type isn't the blob's")
	}
	return c, nil
}

// Parse reads a user certificate's wire encoding.
func Parse(blob []byte) (*Cert, error) {
	r := &reader{b: blob}
	typ := string(r.str())
	kt, ok := keyTypes[typ]
	if !ok {
		if r.err == nil {
			return nil, errors.New("certificate: unknown type " + strconv.Quote(textCut(typ, 64)))
		}
		return nil, r.err
	}
	r.str() // nonce
	start := r.off
	for i := 0; i < kt.fields; i++ {
		r.str()
	}
	keyFields := blob[start:r.off]
	if r.err != nil {
		return nil, r.err
	}
	c := &Cert{Type: typ}
	c.Serial = r.u64()
	role := r.u32()
	c.KeyID = string(r.str())
	principals := r.str()
	r.u64() // valid after
	r.u64() // valid before
	r.str() // critical options
	r.str() // extensions
	r.str() // reserved
	sigKey := r.str()
	r.str() // signature
	if r.err != nil {
		return nil, r.err
	}
	if r.off != len(blob) {
		return nil, errors.New("certificate: bytes after the signature")
	}
	if role != 1 {
		return nil, errors.New("certificate: not a user certificate (type " + strconv.FormatUint(uint64(role), 10) + ")")
	}
	if len(sigKey) == 0 {
		return nil, errors.New("certificate: no signature key")
	}
	pr := &reader{b: principals}
	for pr.off < len(principals) && pr.err == nil {
		p := pr.str()
		if pr.err == nil {
			c.Principals = append(c.Principals, string(p))
		}
	}
	if pr.err != nil {
		return nil, errors.New("certificate: bad principals")
	}
	plain := append(sshString([]byte(kt.plain)), keyFields...)
	c.Key = Fingerprint(plain)
	c.CA = Fingerprint(sigKey)
	return c, nil
}

// Fingerprint is a public key blob's SHA-256 fingerprint as OpenSSH prints it.
func Fingerprint(blob []byte) string {
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// Name is the key ID as the gate logs it (who, MD_RUNBOOK_GATE_WHO, the run report), or why it
// isn't one. The CA writes it, and some CAs let the person choose it: it must be one line of
// printable UTF-8 of at most MaxKeyID bytes, without control or format characters (no line
// breaks, escapes, bidirectional overrides or invisible characters). Spaces are fine, but not at
// either end.
func Name(keyID string) (string, string) {
	switch {
	case keyID == "":
		return "", "empty key ID"
	case len(keyID) > MaxKeyID:
		return "", "key ID longer than " + strconv.Itoa(MaxKeyID) + " bytes"
	case !utf8.ValidString(keyID):
		return "", "key ID not UTF-8"
	case strings.TrimSpace(keyID) != keyID:
		return "", "key ID with a space at either end"
	}
	for _, r := range keyID {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp, unicode.Co, unicode.Cs) || r == unicode.ReplacementChar {
			return "", fmt.Sprintf("key ID with a control or invisible character (U+%04X)", r)
		}
		if unicode.IsSpace(r) && r != ' ' {
			return "", "key ID with a space other than U+0020"
		}
	}
	return keyID, ""
}

func textCut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func sshString(b []byte) []byte {
	out := make([]byte, 4, 4+len(b))
	binary.BigEndian.PutUint32(out, uint32(len(b)))
	return append(out, b...)
}

// reader reads SSH wire types; the first error sticks.
type reader struct {
	b   []byte
	off int
	err error
}

var errShort = errors.New("certificate: too short")

func (r *reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || n > len(r.b)-r.off {
		r.err = errShort
		return nil
	}
	p := r.b[r.off : r.off+n]
	r.off += n
	return p
}

func (r *reader) u32() uint32 {
	p := r.take(4)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint32(p)
}

func (r *reader) u64() uint64 {
	p := r.take(8)
	if p == nil {
		return 0
	}
	return binary.BigEndian.Uint64(p)
}

func (r *reader) str() []byte {
	n := r.u32()
	if r.err != nil {
		return nil
	}
	if uint64(n) > uint64(len(r.b)-r.off) {
		r.err = errShort
		return nil
	}
	return r.take(int(n))
}
