package ere

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

type matchCase struct {
	pattern, value string
	match          bool
}

// Patterns and values as `grep -Eqx -e PATTERN` (GNU grep, LC_ALL=C) reads them. With
// MD_RUNBOOK_GATE_GREP=1, TestAgainstGrep checks this table against the grep on the PATH.
var matchCases = []matchCase{
	// The tests' and docs' patterns.
	{`[a-z][a-z0-9-]{0,30}`, "web-1", true},
	{`[a-z][a-z0-9-]{0,30}`, "Web", false},
	{`[a-z][a-z0-9-]{0,30}`, "web; rm -rf /", false},
	{`[a-z][a-z0-9-]{0,30}`, "$(id)", false},
	{`[a-z][a-z0-9-]{0,30}`, "", false},
	{`[a-z]+`, "a;b", false},
	{`lab-[0-9]+|prod-eu`, "prod-eu", true},
	{`lab-[0-9]+|prod-eu`, "lab-12", true},
	{`lab-[0-9]+|prod-eu`, "lab-12prod-eu", false},
	{`lab-[0-9]+|prod-eu`, "xprod-eu", false},
	// Whole value only: anchors around every alternative.
	{`a|b`, "ab", false},
	{`(a|b)c`, "bc", true},
	// One byte per character (C locale): é is two.
	{`.`, "é", false},
	{`..`, "é", true},
	{`.{1,3}`, "éé", false},
	{`[^a]{2}`, "é", true},
	{`é`, "é", true},
	{`[é]`, "é", false},
	// POSIX classes, and a backslash in brackets is a backslash.
	{`[[:alpha:]][[:digit:]]+`, "a12", true},
	{`[[:upper:]]`, "É", false},
	{`[\]`, `\`, true},
	{`[\.]+`, `\.`, true},
	{`[a\]]`, `a]`, true},
	{`[a\]]`, `]`, false},
	{`[]a]+`, `]a`, true},
	{`[^]a]`, `b`, true},
	{`[^]a]`, `]`, false},
	{`[a-]+`, `a-`, true},
	{`[-a]+`, `-a`, true},
	{`[[.a.]-c]`, `b`, true},
	{`[[=a=]]`, `a`, true},
	{`[[]`, `[`, true},
	// Escapes of special characters; a stray backslash is the character.
	{`a\.b`, "a.b", true},
	{`a\.b`, "axb", false},
	{`\$x`, "$x", true},
	{`a\-b`, "a-b", true},
	{`\t`, "t", true},
	{`\t`, "\t", false},
	// One alternative per line of the pattern, as grep -e.
	{"a\nb", "b", true},
	{"a\nb", "c", false},
	{"", "", true},
	{"", "x", false},
	// Repetitions of repetitions read as grep reads them (signing refuses +? and the like).
	{`a**`, "aaa", true},
	{`a+?`, "", true},
	{`a+?`, "aa", true},
	{`(ab){2}`, "abab", true},
	{`x{2,}`, "x", false},
}

func TestMatchWhole(t *testing.T) {
	for _, c := range matchCases {
		if got := MatchWhole(c.pattern, c.value); got != c.match {
			t.Errorf("MatchWhole(%q, %q) = %v, want %v", c.pattern, c.value, got, c.match)
		}
	}
	// Values with a newline never match (grep would test each line).
	if MatchWhole(`.*`, "a\nb") {
		t.Error("a value with a newline matched")
	}
}

// The table above, as GNU grep reads it (the shell gate's check: printf '%s\n' VALUE | grep -Eqx
// -e PATTERN, in the C locale).
func TestAgainstGrep(t *testing.T) {
	if os.Getenv("MD_RUNBOOK_GATE_GREP") != "1" {
		t.Skip("set MD_RUNBOOK_GATE_GREP=1 to compare with GNU grep")
	}
	for _, c := range append(matchCases, refusedCases()...) {
		cmd := exec.Command("grep", "-Eqx", "-e", c.pattern)
		cmd.Env = append(os.Environ(), "LC_ALL=C")
		cmd.Stdin = strings.NewReader(c.value + "\n")
		err := cmd.Run()
		got := err == nil
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 2 {
			got = false // grep refuses the pattern too
		}
		if got != c.match {
			t.Errorf("grep -Eqx %q on %q: %v, the table says %v", c.pattern, c.value, got, c.match)
		}
	}
}

// Refused patterns that grep reads the same way (no match for the value): compared too.
func refusedCases() []matchCase {
	return []matchCase{{`a\`, "a", false}, {`[a`, "a", false}, {`[z-a]`, "a", false}}
}

// What grep reads otherwise than Go, or GNU-only syntax: refused, so no value matches.
func TestRefused(t *testing.T) {
	// (\d is a digit to the clients (JavaScript) and d to grep: refused, as signing refuses it.)
	for _, p := range []string{`\d+`, `\w`, `\s`, `\bword\b`, `(a)\1`, `a\`, `[a`, `[z-a]`, `*a`, `(?i)a`, `[[:nope:]]`, `[[.ab.]]`, `\<a\>`} {
		if _, err := Compile(p); err == nil {
			t.Errorf("Compile(%q) accepted", p)
		}
		if MatchWhole(p, "a") {
			t.Errorf("MatchWhole(%q, a) matched", p)
		}
	}
}
