package keys

import (
	"reflect"
	"strings"
	"testing"
)

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGdhdGUtdGVzdC1rZXktbm90LXVzZWQtdG8tbG9nLWlu test@gate"

func TestParseLine(t *testing.T) {
	for _, c := range []struct {
		line string
		want Line
	}{
		{key, Line{Kind: KindNoCmd, Open: "restrict"}},
		{`restrict,command="/usr/local/bin/md-runbook-gate --who=a" ` + key, Line{Kind: KindCmd, Cmd: "/usr/local/bin/md-runbook-gate --who=a"}},
		{`command="/g" ` + key, Line{Kind: KindCmd, Open: "restrict", Cmd: "/g"}},
		{`no-pty,no-port-forwarding,command="/g" ` + key, Line{Kind: KindCmd, Open: "restrict", Cmd: "/g"}},
		{`restrict,port-forwarding,command="/g" ` + key, Line{Kind: KindCmd, Open: "port-forwarding", Cmd: "/g"}},
		{`Restrict,PTY,X11-Forwarding,command="/g" ` + key, Line{Kind: KindCmd, Open: "pty,x11-forwarding", Cmd: "/g"}},
		{`port-forwarding,command="/g" ` + key, Line{Kind: KindCmd, Open: "restrict,port-forwarding", Cmd: "/g"}},
		{`restrict,permitopen="localhost:2375",command="/g" ` + key, Line{Kind: KindCmd, Open: "permitopen", Cmd: "/g"}},
		{`restrict,environment="LD_PRELOAD=/tmp/evil.so",command="/g" ` + key, Line{Kind: KindCmd, Env: true, Cmd: "/g"}},
		// Quoted commas, escaped quotes, CRLF.
		{`restrict,from="10.0.0.0/8,192.168.0.0/16",command="/g --who=\"Bob B\"" ` + key + "\r", Line{Kind: KindCmd, Cmd: `/g --who="Bob B"`}},
		// An open quote, two commands.
		{`restrict,command="/g ` + key, Line{Kind: KindBad}},
		{`command="/g",command="/bin/sh" ` + key, Line{Kind: KindBad}},
		{`cert-authority,principals="ops" ` + key, Line{Kind: KindNoCmd, Open: "restrict"}},
	} {
		got, ok := ParseLine(c.line, 7)
		c.want.N = 7
		if !ok || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseLine(%q) = %+v, want %+v", c.line, got, c.want)
		}
	}
	for _, skip := range []string{"", "  \t", "# comment", "   # comment", "\r"} {
		if _, ok := ParseLine(skip, 1); ok {
			t.Errorf("ParseLine(%q) is a key line", skip)
		}
	}
}

func TestParseNumbersLines(t *testing.T) {
	lines, err := Parse(strings.NewReader("# team\n\n" + key + "\ncommand=\"/g\" " + key))
	if err != nil || len(lines) != 2 || lines[0].N != 3 || lines[1].N != 4 || lines[1].Cmd != "/g" {
		t.Errorf("Parse: %+v %v", lines, err)
	}
}

func TestWords(t *testing.T) {
	for in, want := range map[string][]string{
		"/g --who=a":                  {"/g", "--who=a"},
		"exec /g --who='Alice Smith'": {"exec", "/g", "--who=Alice Smith"},
		`/g --who="Bob B"`:            {"/g", "--who=Bob B"},
		"  /g\t--x  ":                 {"/g", "--x"},
		"/g ''":                       {"/g", ""},
	} {
		got, ok := Words(in)
		if !ok || !reflect.DeepEqual(got, want) {
			t.Errorf("Words(%q) = %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"/g; sh", "/g --who=$(id)", "/g --who=a;b", `/g --who="$HOME"`, "/g `id`", "/g 'open", `/g "a\"`, "/g | sh", "/g &", "/g\\x"} {
		if _, ok := Words(bad); ok {
			t.Errorf("Words(%q) accepted", bad)
		}
	}
}

type fakeSys struct {
	files      map[string]string // path -> unsigned of the config
	changeable map[string]bool
}

func (f fakeSys) env(self string) Env {
	return Env{
		Self: self,
		Phys: func(p string) string {
			// /usr/local/bin is a link to /opt/bin.
			return strings.Replace(p, "/usr/local/bin/", "/opt/bin/", 1)
		},
		LookPath: func(name string) (string, bool) {
			if name == "md-runbook-gate" {
				return "/usr/local/bin/md-runbook-gate", true
			}
			return "", false
		},
		Exists:     func(p string) bool { _, ok := f.files[p]; return ok },
		Readable:   func(p string) bool { _, ok := f.files[p]; return ok },
		CanChange:  func(p string) bool { return f.changeable[p] },
		UnsignedOf: func(p string) (string, bool) { return f.files[p], true },
	}
}

func TestCheck(t *testing.T) {
	const self = "/usr/local/bin/md-runbook-gate"
	sys := fakeSys{
		files:      map[string]string{"/etc/md-runbook/gate.conf": "refuse", "/etc/md-runbook/trial.conf": "allow", "/home/a/gate.conf": "allow"},
		changeable: map[string]bool{"/home/a/gate.conf": true},
	}
	e := sys.env(self)
	for _, c := range []struct {
		cmd      string
		r        Result
		unsigned string
	}{
		{self, OK, "refuse"},
		{"exec " + self + " --who='Alice Smith' --scopes=web,staging --signers=2", OK, "refuse"},
		{self + " --unsigned=allow", OK, "allow"},
		{self + " --config=/etc/md-runbook/trial.conf", OK, "allow"},
		{"/opt/bin/md-runbook-gate", OK, "refuse"},
		{"md-runbook-gate", OK, "refuse"},
		{self + " --config=/home/a/gate.conf", ConfigChangeable, ""},
		{self + " --config=/etc/md-runbook/missing.conf", NotGate, ""},
		{"sh " + self, WithShell, ""},
		{"exec /bin/bash " + self + " --who=x", WithShell, ""},
		{"/tmp/elsewhere/md-runbook-gate", NotGate, ""},
		{self + " --sshd-force-command", NotGate, ""},
		{self + " --scopes=", NotGate, ""},
		{self + " --scopes=a*", NotGate, ""},
		{self + " --signers=6", NotGate, ""},
		{self + " --who=", NotGate, ""},
		{self + "; sh", NotGate, ""},
		{"/usr/local/bin/other", NotGate, ""},
		{"", NotGate, ""},
		{"exec", NotGate, ""},
	} {
		r, u, _ := Check(c.cmd, e)
		if r != c.r || u != c.unsigned {
			t.Errorf("Check(%q) = %v %q, want %v %q", c.cmd, r, u, c.r, c.unsigned)
		}
	}
	// No gate.conf at all: refuse, as the gate's defaults.
	none := fakeSys{files: map[string]string{}}.env(self)
	if r, u, _ := Check(self, none); r != OK || u != "refuse" {
		t.Errorf("no config: %v %q", r, u)
	}
}

func TestExpandFiles(t *testing.T) {
	files, _, ok := ExpandFiles("%h/.ssh/authorized_keys %h/keys-%U%%x /etc/ssh/keys/%u rel/keys", "/home/a", "alice", "1000")
	want := []string{"/home/a/.ssh/authorized_keys", "/home/a/keys-1000%x", "/etc/ssh/keys/alice", "/home/a/rel/keys"}
	if !ok || !reflect.DeepEqual(files, want) {
		t.Errorf("ExpandFiles = %q %v", files, ok)
	}
	for setting, tok := range map[string]string{"%h/keys-%z": "z", "/keys%": ""} {
		if _, bad, ok := ExpandFiles(setting, "/h", "a", "1"); ok || bad != tok {
			t.Errorf("ExpandFiles(%q): %q %v", setting, bad, ok)
		}
	}
}
