// Package keys reads authorized_keys lines as sshd reads their options, and checks that a key
// line's command= is this gate with its own options only ("all signed or none": every key of the
// account runs the gate; security review, 2026-11-16).
package keys

import (
	"bufio"
	"io"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Kind of a key line.
const (
	KindCmd   = "cmd"   // a command= option
	KindNoCmd = "nocmd" // none
	KindBad   = "bad"   // an open quote, or two command= options
)

// Line is one key line (comments and blank lines are skipped).
type Line struct {
	N    int    // its line number in the file
	Kind string // KindCmd, KindNoCmd or KindBad
	// Open: "" when the line has restrict and turns nothing on again; else the options to change,
	// comma-separated ("restrict" first when restrict is missing). (Not the five no-* options
	// instead: sshd's tunnel check looks for restrict itself; security review round 4.)
	Open string
	// Env: the line sets environment= (with PermitUserEnvironment, LD_PRELOAD or BASH_ENV there
	// runs code before the gate; security review round 4).
	Env bool
	// Cmd: the command= value, its quotes read as sshd reads them.
	Cmd string
}

// What turns on again what restrict turns off.
var again = map[string]bool{
	"port-forwarding": true, "permitopen": true, "permitlisten": true, "pty": true,
	"user-rc": true, "x11-forwarding": true, "agent-forwarding": true,
}

// ParseLine reads one line (without its newline). ok is false for a comment or a blank line.
// Options as sshd reads them: comma-separated up to the first blank outside quotes, \" in quotes
// a quote.
func ParseLine(raw string, n int) (Line, bool) {
	raw = strings.TrimSuffix(raw, "\r")
	s := strings.TrimLeft(raw, " \t")
	if s == "" || s[0] == '#' {
		return Line{}, false
	}
	if strings.HasPrefix(s, "ssh-") || strings.HasPrefix(s, "ecdsa-") || strings.HasPrefix(s, "sk-") {
		return Line{N: n, Kind: KindNoCmd, Open: "restrict"}, true
	}
	var cur strings.Builder
	var cmd string
	ncmd := 0
	seen := map[string]bool{}
	var on []string
	inq := false
	for i := 0; i < len(s); {
		c := s[i]
		if inq {
			if c == '\\' && i+1 < len(s) && s[i+1] == '"' {
				cur.WriteByte('"')
				i += 2
				continue
			}
			if c == '"' {
				inq = false
			} else {
				cur.WriteByte(c)
			}
			i++
			continue
		}
		if c == '"' {
			inq = true
			i++
			continue
		}
		if c == ',' || c == ' ' || c == '\t' {
			opt := cur.String()
			name, _, _ := strings.Cut(textutil.ASCIILower(opt), "=")
			if name == "command" {
				_, cmd, _ = strings.Cut(opt, "=")
				ncmd++
			}
			seen[name] = true
			if again[name] {
				on = append(on, name)
			}
			cur.Reset()
			if c != ',' {
				break
			}
			i++
			continue
		}
		cur.WriteByte(c)
		i++
	}
	if inq || ncmd > 1 {
		return Line{N: n, Kind: KindBad}, true
	}
	open := strings.Join(on, ",")
	if !seen["restrict"] {
		if open == "" {
			open = "restrict"
		} else {
			open = "restrict," + open
		}
	}
	kind := KindNoCmd
	if ncmd > 0 {
		kind = KindCmd
	}
	// (The shell gate read the command back with IFS=tab: tabs around it went.)
	return Line{N: n, Kind: kind, Open: open, Env: seen["environment"], Cmd: strings.Trim(cmd, "\t")}, true
}

// Parse reads every key line of r.
func Parse(r io.Reader) ([]Line, error) {
	var out []Line
	br := bufio.NewReader(r)
	n := 0
	for {
		raw, err := br.ReadString('\n')
		if raw == "" && err != nil {
			if err == io.EOF {
				return out, nil
			}
			return nil, err
		}
		n++
		if l, ok := ParseLine(strings.TrimSuffix(raw, "\n"), n); ok {
			out = append(out, l)
		}
		if err != nil {
			if err == io.EOF {
				return out, nil
			}
			return nil, err
		}
	}
}

// Words reads text as a simple sh word list: blanks between words, '…' and "…" quotes, nothing
// a shell would expand or run ($, `, \, ;, |, & and the like): else ok is false (security review
// round 3: exec and quoted values are fine).
func Words(text string) ([]string, bool) {
	var words []string
	var w strings.Builder
	inw := false
	for i := 0; i < len(text); {
		c := text[i]
		if c == ' ' || c == '\t' {
			if inw {
				words = append(words, w.String())
			}
			w.Reset()
			inw = false
			i++
			continue
		}
		if c == '\'' || c == '"' {
			j := strings.IndexByte(text[i+1:], c)
			if j < 0 {
				return nil, false
			}
			t := text[i+1 : i+1+j]
			if c == '"' && strings.ContainsAny(t, "$`\\") {
				return nil, false
			}
			w.WriteString(t)
			inw = true
			i += j + 2
			continue
		}
		if !plain(c) {
			return nil, false
		}
		w.WriteByte(c)
		inw = true
		i++
	}
	if inw {
		words = append(words, w.String())
	}
	return words, true
}

func plain(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("._/@:,+=%-", c) >= 0
}

// Shells a key line may not put before the gate. (The shell gate was a script, run as `sh
// md-runbook-gate` too; the gate is a program now, which sh can't run.)
var shells = map[string]bool{
	"sh": true, "/bin/sh": true, "/usr/bin/sh": true, "dash": true, "/bin/dash": true, "/usr/bin/dash": true,
	"bash": true, "/bin/bash": true, "/usr/bin/bash": true,
}

// Env is what a command check needs from the system.
type Env struct {
	// Self: this gate's path (the shell gate's $0).
	Self string
	// Phys: a path with its folder's links resolved; "" when it can't be.
	Phys func(path string) string
	// LookPath: a command name found in the gate's PATH.
	LookPath func(name string) (string, bool)
	// Exists, Readable: the file is there ([ -e ]), the account can read it ([ -r ]).
	Exists, Readable func(path string) bool
	// CanChange: the account could change the file.
	CanChange func(path string) bool
	// UnsignedOf: the unsigned setting of a gate.conf.
	UnsignedOf func(path string) (string, bool)
}

// Result of a command check.
type Result int

const (
	// OK: the command runs this gate; Unsigned says what it allows.
	OK Result = iota
	// NotGate: the command isn't this gate with its own options only.
	NotGate
	// WithShell: the command runs this gate through sh or bash, which can't run a program.
	WithShell
	// ConfigChangeable: its --config= is a file the account can change (Config names it).
	ConfigChangeable
)

// Check checks a key line's command= (security review rounds 3 and 4). It returns what the line
// allows (allow or refuse) when the command is this gate with only its own options.
func Check(cmd string, e Env) (r Result, unsigned, config string) {
	words, ok := Words(cmd)
	if !ok {
		return NotGate, "", ""
	}
	// (As the shell gate read the words back: empty words at the end went.)
	for len(words) > 0 && words[len(words)-1] == "" {
		words = words[:len(words)-1]
	}
	if len(words) > 0 && words[0] == "exec" {
		words = words[1:]
	}
	withShell := false
	if len(words) > 0 && shells[words[0]] {
		words = words[1:]
		withShell = true
	}
	if len(words) == 0 {
		return NotGate, "", ""
	}
	g := words[0]
	for i := 0; i < len(g); i++ {
		c := g[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("._/:+-", c) >= 0) {
			return NotGate, "", ""
		}
	}
	if g != "md-runbook-gate" && !strings.HasSuffix(g, "/md-runbook-gate") {
		return NotGate, "", ""
	}
	if !strings.Contains(g, "/") {
		p, found := e.LookPath(g)
		if !found {
			return NotGate, "", ""
		}
		g = p
	}
	// The same program as this one (a copy the account could change would check nothing): the
	// same path, or the same file name in the same folder once links are resolved.
	if g != e.Self {
		self := e.Phys(e.Self)
		if self == "" || e.Phys(g) != self {
			return NotGate, "", ""
		}
	}
	u := ""
	c := "/etc/md-runbook/gate.conf"
	cset := false
	// --sshd-force-command is for sshd_config's ForceCommand, never a key line.
	for _, a := range words[1:] {
		switch {
		case a == "--unsigned=allow" || a == "--unsigned=refuse":
			u = a[len("--unsigned="):]
		case strings.HasPrefix(a, "--config=") && len(a) > len("--config="):
			c = a[len("--config="):]
			cset = true
		case strings.HasPrefix(a, "--scopes="):
			v := a[len("--scopes="):]
			if v == "" || !scopeChars(v) {
				return NotGate, "", ""
			}
		case len(a) == len("--signers=N") && strings.HasPrefix(a, "--signers=") && a[10] >= '1' && a[10] <= '5':
		case strings.HasPrefix(a, "--who=") && len(a) > len("--who="):
		default:
			return NotGate, "", ""
		}
	}
	if withShell {
		return WithShell, "", ""
	}
	// The config a key line runs with decides its policy and signers: never one the account
	// could change, as for sshd_force_command (security review round 4).
	if e.Exists(c) && e.CanChange(c) {
		return ConfigChangeable, "", c
	}
	if u == "" {
		switch {
		case e.Readable(c):
			v, ok := e.UnsignedOf(c)
			if !ok {
				return NotGate, "", ""
			}
			u = v
		case cset || e.Exists(c):
			return NotGate, "", ""
		default:
			u = "refuse"
		}
	}
	if u != "allow" && u != "refuse" {
		return NotGate, "", ""
	}
	return OK, u, ""
}

func scopeChars(v string) bool {
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("._/@:,+-", c) >= 0) {
			return false
		}
	}
	return true
}

// ExpandFiles turns authorized_keys = into paths: the tokens sshd expands in AuthorizedKeysFile
// (%h, %u, %U, %%), relative paths in the home folder. Any other token is an error (bad is the
// token, "" for a % at the end): a file the gate didn't read could let a key in.
func ExpandFiles(setting, home, account, uid string) (files []string, bad string, ok bool) {
	for _, f := range textutil.Fields(setting) {
		var p strings.Builder
		for {
			i := strings.IndexByte(f, '%')
			if i < 0 {
				break
			}
			p.WriteString(f[:i])
			f = f[i+1:]
			if f == "" {
				return nil, "", false
			}
			switch f[0] {
			case 'h':
				p.WriteString(home)
			case 'u':
				p.WriteString(account)
			case 'U':
				p.WriteString(uid)
			case '%':
				p.WriteByte('%')
			default:
				return nil, f[:1], false
			}
			f = f[1:]
		}
		path := p.String() + f
		if !strings.HasPrefix(path, "/") {
			path = home + "/" + path
		}
		files = append(files, path)
	}
	return files, "", true
}
