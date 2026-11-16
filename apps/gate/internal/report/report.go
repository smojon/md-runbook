// Package report builds the run summaries the gate sends with report_to: one per signed runbook a
// session ran (the format of docs/features/run-reports.md, client "gate"): its signed name,
// version, manifest hash and signers, the key (who), the server, account and client address, and
// each signed block's state. Never a parameter value or an output.
//
// While the session runs, the gate keeps a Run per run in memory (Step "-" for a whole block;
// Nonce random). The shell adds "N EXIT TIME NONCE" to the work folder's report-exits when run N
// ends: the nonce is in the text it gets after the block, so no block can write a line that
// counts for another run; the first line with the right nonce counts (security review round 3).
// A run with no end (the session was cut, or a block ran `exit`) makes the summary `stopped`.
package report

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Run is one signed run of a session.
type Run struct {
	N     string // the gate's run number
	Hash  string // the manifest's sha256
	Cell  string
	Step  string // "-" for the whole block
	Start string // UTC time
	Nonce string
}

// Exit is a line of report-exits.
type Exit struct{ RC, Time string }

// ReadExits reads report-exits: for each run, its first line whose nonce is that run's.
func ReadExits(r io.Reader, runs []Run) map[string]Exit {
	nonce := map[string]string{}
	for _, run := range runs {
		nonce[run.N] = run.Nonce
	}
	out := map[string]Exit{}
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line == "" && err != nil {
			break
		}
		f := strings.Split(strings.TrimSuffix(line, "\n"), "\t")
		get := func(i int) string {
			if i < len(f) {
				return f[i]
			}
			return ""
		}
		n := get(0)
		if want, ok := nonce[n]; ok && want != "" {
			if _, done := out[n]; !done && get(3) == want {
				out[n] = Exit{RC: get(1), Time: get(2)}
			}
		}
		if err != nil {
			break
		}
	}
	return out
}

// Session is what a summary says about the session. Mode is the gate's: separated (the cells ran
// as an account of their own), else shared.
type Session struct {
	Who, Account, Client, Host, Mode string
}

// Separated is the mode of a gate whose cells run as an account of their own (cells_account).
const Separated = "separated"

// Shared is the mode of a gate whose cells run as its own account.
const Shared = "shared"

// Label is a block's label: the first line of its code with words, its blanks collapsed, at most
// 120 bytes; "Step N" when there is none.
func Label(m *manifest.Manifest, cell string) string {
	code, err := base64.StdEncoding.DecodeString(m.Field("code", cell, 2))
	if err != nil {
		code = nil
	}
	label := ""
	for _, l := range strings.Split(string(code), "\n") {
		if w := textutil.Fields(l); len(w) > 0 {
			label = strings.Join(w, " ")
			break
		}
	}
	label = textutil.Cut(label, 120)
	if label == "" {
		label = "Step " + cell
	}
	return label
}

// Summary is the run summary (JSON) of the runbook with manifest hash h, from its runs (in order,
// the session's runs of every runbook: those of h count), the exits and the time now. signer is
// the first load's principals.
func Summary(m *manifest.Manifest, h, signer string, runs []Run, exits map[string]Exit, s Session, now string) string {
	// The blocks: each `cell N` line with a whole number N (the last of a number counts).
	labels := map[int]string{}
	last := map[int]int{}
	cells := 0
	for _, c := range m.Cells() {
		if !textutil.IsNum(c) {
			continue
		}
		n := atoi(c)
		labels[n] = textutil.JSON(Label(m, c))
		last[n] = m.LastStep(c)
		if n > cells {
			cells = n
		}
	}
	// A block's state is its last run's: failed on a non-zero exit; passed when it ran whole, or
	// its last command ran; otherwise (only some commands, or no end) not-run.
	state := map[int]string{}
	ran := map[int]bool{}
	started, ended := "", ""
	stopped := false
	for _, r := range runs {
		if r.Hash != h {
			continue
		}
		c := atoi(r.Cell)
		if started == "" {
			started = r.Start
		}
		ran[c] = true
		e, ok := exits[r.N]
		if !ok {
			state[c] = "not-run"
			stopped = true
			continue
		}
		if e.Time > ended {
			ended = e.Time
		}
		switch {
		case !zero(e.RC):
			state[c] = "failed"
		case r.Step == "-" || atoi(r.Step) == last[c]:
			state[c] = "passed"
		default:
			state[c] = "not-run"
		}
	}
	var steps, rl []string
	p, f, nr := 0, 0, 0
	for n := 1; n <= cells; n++ {
		st, ok := state[n]
		if !ok {
			st = "not-run"
		}
		switch st {
		case "passed":
			p++
		case "failed":
			f++
		default:
			nr++
		}
		label, ok := labels[n]
		if !ok {
			label = textutil.JSON(fmt.Sprintf("Step %d", n))
		}
		steps = append(steps, fmt.Sprintf(`{"n":%d,"label":%s,"state":"%s"}`, n, label, st))
		if ran[n] {
			rl = append(rl, fmt.Sprint(n))
		}
	}
	if started == "" {
		started = now
	}
	if ended == "" || stopped {
		ended = now
	}
	green := cells > 0 && f == 0 && nr == 0
	tail := fmt.Sprintf(`"steps":[%s],"ran":[%s],"totals":{"steps":%d,"passed":%d,"failed":%d,"skipped":0,"notRun":%d,"byHand":0},"green":%t,"started":"%s","ended":"%s"`,
		strings.Join(steps, ","), strings.Join(rl, ","), cells, p, f, nr, green, started, ended)
	if stopped {
		tail += `,"stopped":true`
	}
	// Name and version from the manifest itself (its hash was checked); the signers from memory
	// (a file next to it was a block's to change; security review round 4).
	version := m.Field("version", "", 2)
	if !textutil.IsNum(version) {
		version = "0"
	}
	who := s.Who
	if who == "" {
		who = s.Account
	}
	from := ""
	if s.Client != "" {
		from = `,"from":` + textutil.JSON(textutil.Cut(s.Client, 64))
	}
	// Exactly shared or separated, in the gate object: the library server refuses any other value
	// (and a top-level gate_mode).
	mode := Shared
	if s.Mode == Separated {
		mode = Separated
	}
	return fmt.Sprintf(`{"v":1,"client":"gate","runbook":{"signed":{"name":%s,"version":%s,"manifest":"%s","signer":%s,"trusted":true}},"who":%s,"gate":{"host":%s,"account":%s%s,"gate_mode":"%s"},%s}`,
		textutil.JSON(m.Field("name", "", 2)), version, h, textutil.JSON(textutil.Cut(signer, 120)), textutil.JSON(textutil.Cut(who, 120)),
		textutil.JSON(textutil.Cut(s.Host, 255)), textutil.JSON(textutil.Cut(s.Account, 64)), from, mode, tail)
}

// atoi reads a field as awk's $x + 0 does (a leading number, else 0), for whole numbers.
func atoi(s string) int {
	n := 0
	for i := 0; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
		if n > 1<<30 {
			break
		}
	}
	return n
}

// zero: an exit code awk reads as 0 (rc != 0 is false).
func zero(rc string) bool {
	if rc == "" {
		return false
	}
	for i := 0; i < len(rc); i++ {
		if rc[i] != '0' {
			return false
		}
	}
	return true
}
