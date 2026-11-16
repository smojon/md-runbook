package report

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func sample() *manifest.Manifest {
	return manifest.Parse("md-runbook-manifest 1\nname ops/report\nversion 4\n" +
		"cell 1 all\ninfo " + b64("bash") + "\ncode " + b64("\n  echo   ok  \n") + "\n" +
		"cell 2 all\ninfo " + b64("bash") + "\ncode " + b64("false") + "\n" +
		"cell 3 all\ninfo " + b64("bash") + "\ncode " + b64("echo a\necho b") + "\nstep " + b64("echo a") + "\nstep " + b64("echo b") + "\n" +
		"cell 4 all\ninfo " + b64("bash") + "\ncode " + b64("   \n") + "\n" +
		"end\n")
}

const h = "ab0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"

func TestReadExits(t *testing.T) {
	runs := []Run{{N: "1", Nonce: "aa"}, {N: "2", Nonce: "bb"}}
	// A forged line for run 2 (wrong nonce) before and after the real one; the first right one counts.
	exits := ReadExits(strings.NewReader("2\t0\tT0\t0123abcd\n1\t0\tT1\taa\n2\t1\tT2\tbb\n2\t0\tT3\tbb\n3\t0\tT\tcc\n02\t0\tT\tbb"), runs)
	want := map[string]Exit{"1": {"0", "T1"}, "2": {"1", "T2"}}
	if !reflect.DeepEqual(exits, want) {
		t.Errorf("exits: %+v", exits)
	}
}

func TestSummary(t *testing.T) {
	m := sample()
	runs := []Run{
		{N: "1", Hash: h, Cell: "1", Step: "-", Start: "2026-11-16T10:00:00Z", Nonce: "a"},
		{N: "2", Hash: "other", Cell: "1", Step: "-", Start: "2026-11-16T10:00:01Z", Nonce: "x"},
		{N: "3", Hash: h, Cell: "2", Step: "-", Start: "2026-11-16T10:00:02Z", Nonce: "b"},
		{N: "4", Hash: h, Cell: "3", Step: "0", Start: "2026-11-16T10:00:03Z", Nonce: "c"},
	}
	exits := map[string]Exit{"1": {"0", "2026-11-16T10:00:01Z"}, "3": {"1", "2026-11-16T10:00:05Z"}, "4": {"0", "2026-11-16T10:00:04Z"}}
	body := Summary(m, h, "ops@example.net", runs, exits, Session{Account: "support", Client: "192.0.2.1", Host: "web-1"}, "2026-11-16T10:01:00Z")
	var s map[string]any
	if err := json.Unmarshal([]byte(body), &s); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, body)
	}
	want := `{"v":1,"client":"gate","runbook":{"signed":{"name":"ops/report","version":4,"manifest":"` + h + `","signer":"ops@example.net","trusted":true}},` +
		`"who":"support","gate":{"host":"web-1","account":"support","from":"192.0.2.1"},` +
		`"steps":[{"n":1,"label":"echo ok","state":"passed"},{"n":2,"label":"false","state":"failed"},{"n":3,"label":"echo a","state":"not-run"},{"n":4,"label":"Step 4","state":"not-run"}],` +
		`"ran":[1,2,3],"totals":{"steps":4,"passed":1,"failed":1,"skipped":0,"notRun":2,"byHand":0},"green":false,"started":"2026-11-16T10:00:00Z","ended":"2026-11-16T10:00:05Z"}`
	if body != want {
		t.Errorf("summary:\n%s\nwant\n%s", body, want)
	}
	// The last command of a block passes it; a run without an end makes the summary stopped.
	runs = append(runs, Run{N: "5", Hash: h, Cell: "3", Step: "1", Start: "T", Nonce: "d"}, Run{N: "6", Hash: h, Cell: "4", Step: "-", Start: "T", Nonce: "e"})
	exits["5"] = Exit{"0", "2026-11-16T10:00:06Z"}
	body = Summary(m, h, "ops@example.net", runs, exits, Session{Who: "SHA256:abc", Account: "support"}, "2026-11-16T10:01:00Z")
	if !strings.Contains(body, `{"n":3,"label":"echo a","state":"passed"}`) || !strings.Contains(body, `"ended":"2026-11-16T10:01:00Z","stopped":true}`) ||
		!strings.Contains(body, `"who":"SHA256:abc"`) || strings.Contains(body, `"from"`) {
		t.Errorf("summary: %s", body)
	}
	// No run: started and ended now.
	body = Summary(m, h, "x", nil, nil, Session{}, "2026-11-16T10:01:00Z")
	if !strings.Contains(body, `"ran":[],`) || !strings.Contains(body, `"started":"2026-11-16T10:01:00Z","ended":"2026-11-16T10:01:00Z"}`) {
		t.Errorf("summary: %s", body)
	}
}

func TestLabel(t *testing.T) {
	m := manifest.Parse("md-runbook-manifest 1\ncell 1 all\ncode " + b64(strings.Repeat("x", 130)) + "\ncell 2 all\ncode notbase64!\n")
	if got := Label(m, "1"); got != strings.Repeat("x", 120) {
		t.Errorf("label: %q", got)
	}
	if got := Label(m, "2"); got != "Step 2" {
		t.Errorf("label: %q", got)
	}
}
