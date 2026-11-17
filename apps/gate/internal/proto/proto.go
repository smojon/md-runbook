// Package proto reads the gate's line protocol: one request per line, words separated by blanks,
// base64 for anything that could hold spaces. Replies end with the end-of-cell marker of a plain
// shell session (\036__MDRB_<id>__ <exit>, on stdout and stderr).
package proto

import (
	"bufio"
	"encoding/base64"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// MaxLine is the longest request: a longer one ends the session, and the gate reads no more of it
// (before, the shell gate read a whole 32 MB line: 67 MB and 24 seconds; security review round 4).
const MaxLine = 4000000

// ErrTooLong: a request longer than MaxLine bytes.
var ErrTooLong = errors.New("request too long")

// Reader reads requests. It never holds more than MaxLine bytes of a request (plus its buffer).
type Reader struct {
	br  *bufio.Reader
	buf []byte
}

// NewReader reads requests from r.
func NewReader(r io.Reader) *Reader { return &Reader{br: bufio.NewReaderSize(r, 64*1024)} }

// Next is the next request, without its newline. io.EOF at the end; a last line without a newline
// is not a request (the shell gate's read dropped it). ErrTooLong for a line over MaxLine bytes.
func (r *Reader) Next() (string, error) {
	r.buf = r.buf[:0]
	for {
		chunk, err := r.br.ReadSlice('\n')
		if err == nil {
			chunk = chunk[:len(chunk)-1]
		}
		if len(r.buf)+len(chunk) > MaxLine {
			r.buf = nil
			return "", ErrTooLong
		}
		r.buf = append(r.buf, chunk...)
		switch err {
		case nil:
			return string(r.buf), nil
		case bufio.ErrBufferFull:
			continue
		default:
			return "", err
		}
	}
}

// Marker is the end-of-cell marker of request id with its exit (a session number for the hello).
func Marker(id, exit string) string { return "\x1e__MDRB_" + id + "__ " + exit + "\n" }

// Banner answers the hello: the protocol and whether unsigned blocks run.
func Banner(protocol, unsigned string) string {
	return "\x1e__MDRB_GATE__ " + protocol + " unsigned=" + unsigned + "\n"
}

// PodNotices is the word of the hello by which a client takes pod notices (protocol 4).
const PodNotices = "pod-notices"

// Hello reads the app's first line, its words after the ":": `mdrb-gate-hello ID; ...`, or
// `mdrb-gate-hello ID pod-notices; ...` from a client that takes pod notices (protocol 4; older
// gates read the ID alike). The rest is for a plain shell. ok: a hello with a request ID.
func Hello(args []string) (rid string, podNotices, ok bool) {
	if len(args) < 2 || args[0] != "mdrb-gate-hello" {
		return "", false, false
	}
	rid = strings.TrimSuffix(args[1], ";")
	podNotices = rid == args[1] && len(args) > 2 && args[2] == PodNotices+";"
	return rid, podNotices, textutil.IsID(rid)
}

// Pod notices (protocol 4, to a client whose hello takes them): where the session's cells run in
// a Kubernetes Job, the pod's start is no part of a request's time limit. One line each:
//   - PodJob, after the banner: the cells run in a Job's pod, not ready yet; pod notices may
//     come until PodReady or PodFailed (none after: a block's output can't fake one);
//   - PodStarting, on stderr before a request whose reply waits for the pod;
//   - PodReady, on stderr: the pod is ready, the request runs;
//   - PodFailed REASON, on stderr: the pod won't come; the session ends.
const (
	PodJob      = "job"
	PodStarting = "starting"
	PodReady    = "ready"
	PodFailed   = "failed"
)

// Pod is a pod notice: \036__MDRB_POD__ STATE, and for PodFailed the reason: one line of
// printable text, at most 500 bytes.
func Pod(state, reason string) string {
	if state != PodFailed {
		return "\x1e__MDRB_POD__ " + state + "\n"
	}
	var b strings.Builder
	for _, r := range strings.ToValidUTF8(reason, "?") {
		if r < 0x20 || r >= 0x7f && r <= 0x9f || r == 0x2028 || r == 0x2029 {
			r = ' '
		}
		b.WriteRune(r)
	}
	why := strings.TrimSpace(b.String())
	for len(why) > 500 {
		_, n := utf8.DecodeLastRuneInString(why)
		why = why[:len(why)-n]
	}
	if why == "" {
		why = "the session's pod didn't start"
	}
	return "\x1e__MDRB_POD__ " + PodFailed + " " + why + "\n"
}

// Decode is base64 (standard, padded) to bytes.
func Decode(s string) ([]byte, bool) {
	b, err := base64.StdEncoding.DecodeString(s)
	return b, err == nil
}

// Note is what a `note` request says about the next load (protocol 3): the alert it answers.
type Note struct{ Alert, Fingerprint, StartsAt string }

var startsAt = regexp.MustCompilePOSIX(`^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?$`)

// ParseNote reads the KEY VALUE pairs of a note request. Only for the log: it grants nothing and
// runs nothing. Each value is base64 and checked strictly: ALERT (required) 1 to 400 bytes,
// ALERT_FINGERPRINT letters, digits and . _ : - (at most 128), ALERT_STARTS_AT an RFC 3339 time;
// none with a control character; each key once. A bad note is refused whole (and kept from no
// load).
func ParseNote(args []string) (Note, bool) {
	var n Note
	if len(args) < 2 || len(args) > 6 || len(args)%2 != 0 {
		return n, false
	}
	seen := map[string]bool{}
	for i := 0; i < len(args); i += 2 {
		key, b64 := args[i], args[i+1]
		if seen[key] {
			return n, false
		}
		seen[key] = true
		// The base64 of 400 bytes is 536 characters: nothing longer is decoded.
		if len(b64) > 600 || !isB64(b64) {
			return n, false
		}
		v, ok := Decode(b64)
		if !ok || len(v) == 0 {
			return n, false
		}
		// One line of text: no newline, NUL or other control character.
		for _, c := range v {
			if c < 0x20 || c == 0x7f {
				return n, false
			}
		}
		val := string(v)
		switch key {
		case "ALERT":
			if len(v) > 400 {
				return n, false
			}
			n.Alert = val
		case "ALERT_FINGERPRINT":
			if len(v) > 128 || strings.IndexFunc(val, func(r rune) bool {
				return !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == ':' || r == '-')
			}) >= 0 {
				return n, false
			}
			n.Fingerprint = val
		case "ALERT_STARTS_AT":
			if !startsAt.MatchString(val) {
				return n, false
			}
			n.StartsAt = val
		default:
			return n, false
		}
	}
	return n, n.Alert != ""
}

func isB64(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=') {
			return false
		}
	}
	return true
}
