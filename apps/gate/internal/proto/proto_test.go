package proto

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

func TestReader(t *testing.T) {
	r := NewReader(strings.NewReader("one\n\ntwo words\r\n" + strings.Repeat("b", MaxLine) + "\nlast without newline"))
	for _, want := range []string{"one", "", "two words\r", strings.Repeat("b", MaxLine)} {
		got, err := r.Next()
		if err != nil || got != want {
			t.Fatalf("Next = %.40q %v, want %.40q", got, err, want)
		}
	}
	// A last line without a newline is not a request.
	if got, err := r.Next(); err != io.EOF || got != "" {
		t.Fatalf("last: %q %v", got, err)
	}
}

func TestReaderTooLong(t *testing.T) {
	r := NewReader(strings.NewReader(strings.Repeat("a", MaxLine+1) + "\n: mdrb-gate-hello feed0001; x\n"))
	if _, err := r.Next(); err != ErrTooLong {
		t.Fatalf("err = %v", err)
	}
	// Also without a newline: the gate never holds more than MaxLine bytes.
	r = NewReader(strings.NewReader(strings.Repeat("a", MaxLine+70000)))
	if _, err := r.Next(); err != ErrTooLong {
		t.Fatalf("err = %v", err)
	}
}

func TestMarkerBanner(t *testing.T) {
	if Marker("feed0001", "126") != "\x1e__MDRB_feed0001__ 126\n" {
		t.Error("marker")
	}
	if Banner("3", "refuse") != "\x1e__MDRB_GATE__ 3 unsigned=refuse\n" {
		t.Error("banner")
	}
}

func TestHello(t *testing.T) {
	cases := []struct {
		line          string
		rid           string
		notices, isOK bool
	}{
		{`: mdrb-gate-hello feed0001; printf x`, "feed0001", false, true},
		{`: mdrb-gate-hello feed0001 pod-notices; printf x`, "feed0001", true, true},
		{`: mdrb-gate-hello feed0001 pod-notices`, "feed0001", false, true},
		{`: mdrb-gate-hello feed0001; pod-notices; printf x`, "feed0001", false, true},
		{`: mdrb-gate-hello feed0001 other; printf x`, "feed0001", false, true},
		{`: mdrb-gate-hello feed0001`, "feed0001", false, true},
		{`: mdrb-gate-hello FEED; x`, "FEED", false, false},
		{`: mdrb-gate-hello ; x`, ";", false, false},
		{`: other feed0001; x`, "", false, false},
		{`:`, "", false, false},
	}
	for _, c := range cases {
		f := strings.Fields(c.line)[1:]
		rid, notices, ok := Hello(f)
		if ok != c.isOK || notices != c.notices || (ok && rid != c.rid) {
			t.Errorf("Hello(%q) = %q %v %v", c.line, rid, notices, ok)
		}
	}
}

func TestPod(t *testing.T) {
	for state, want := range map[string]string{PodJob: "\x1e__MDRB_POD__ job\n", PodStarting: "\x1e__MDRB_POD__ starting\n", PodReady: "\x1e__MDRB_POD__ ready\n"} {
		if got := Pod(state, "ignored"); got != want {
			t.Errorf("Pod(%s) = %q", state, got)
		}
	}
	// One line of printable text: control characters and line separators become spaces.
	if got := Pod(PodFailed, " its pod can't start\n(ImagePullBackOff:\x1e x\x00é ) "); got != "\x1e__MDRB_POD__ failed its pod can't start (ImagePullBackOff:  x é )\n" {
		t.Errorf("failed: %q", got)
	}
	if got := Pod(PodFailed, "\n"); got != "\x1e__MDRB_POD__ failed the session's pod didn't start\n" {
		t.Errorf("empty reason: %q", got)
	}
	// At most 500 bytes, cut at a character.
	if got, want := Pod(PodFailed, strings.Repeat("é", 400)), "\x1e__MDRB_POD__ failed "+strings.Repeat("é", 250)+"\n"; got != want {
		t.Errorf("long: %d bytes", len(got))
	}
}

func b(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestParseNote(t *testing.T) {
	n, ok := ParseNote([]string{"ALERT", b(`ApiDown "x" $(touch pwned) é`), "ALERT_FINGERPRINT", b("5f3c9e:a.b_c-d"), "ALERT_STARTS_AT", b("2026-11-14T08:58:00.123Z")})
	if !ok || n.Alert != `ApiDown "x" $(touch pwned) é` || n.Fingerprint != "5f3c9e:a.b_c-d" || n.StartsAt != "2026-11-14T08:58:00.123Z" {
		t.Errorf("note: %+v %v", n, ok)
	}
	for _, starts := range []string{"2026-11-14 08:58+01:00", "2026-11-14t08:58:00z", "2026-11-14T08:58:00-0130"} {
		if _, ok := ParseNote([]string{"ALERT", b("A"), "ALERT_STARTS_AT", b(starts)}); !ok {
			t.Errorf("starts at %q refused", starts)
		}
	}
	if _, ok := ParseNote([]string{"ALERT", b(strings.Repeat("x", 400))}); !ok {
		t.Error("400 bytes refused")
	}
	bad := [][]string{
		{},
		{"ALERT"},
		{"ALERT_FINGERPRINT", b("abc")},
		{"ALERT", b("A"), "ALERT", b("B")},
		{"ALERT", b("A"), "ALERT_LABELS", b("a=b")},
		{"ALERT", "not base64!"},
		{"ALERT", "QUJD="},
		{"ALERT", ""},
		{"ALERT", b("two\nlines")},
		{"ALERT", b("bell\x07")},
		{"ALERT", b("del\x7f")},
		{"ALERT", b("nul\x00")},
		{"ALERT", b(strings.Repeat("x", 401))},
		{"ALERT", strings.Repeat("QUFB", 151)},
		{"ALERT", b("A"), "ALERT_FINGERPRINT", b("has space")},
		{"ALERT", b("A"), "ALERT_FINGERPRINT", b(strings.Repeat("f", 129))},
		{"ALERT", b("A"), "ALERT_FINGERPRINT", b("é")},
		{"ALERT", b("A"), "ALERT_STARTS_AT", b("yesterday")},
		{"ALERT", b("A"), "ALERT_STARTS_AT", b("2026-11-14T08:58:00Z; rm -rf /")},
		{"ALERT", b("A"), "ALERT_FINGERPRINT", b("a"), "ALERT_STARTS_AT", b("2026-11-14T08:58Z"), "ALERT", b("B")},
	}
	for _, args := range bad {
		if _, ok := ParseNote(args); ok {
			t.Errorf("ParseNote(%q) accepted", args)
		}
	}
}
