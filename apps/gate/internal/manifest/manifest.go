// Package manifest reads a verified md-runbook manifest the way the shell gate's awk read it:
// one item per line, words split at blanks, items found by key (the first one counts), and a
// cell's items being those after its `cell N` line. Always from the verified copy in memory,
// never from a file a cell could change.
package manifest

import (
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Header is the first line of every manifest the gate reads. Version 2 manifests keep it: their
// `text` item (a hash of the whole runbook, for clients) is read by no one here, as items are
// read by key.
const Header = "md-runbook-manifest 1"

// Manifest is a manifest's text, split into lines of words.
type Manifest struct {
	Text  string
	lines []line
}

type line struct {
	raw   string
	words []string
}

// Parse splits text into lines (at \n, as awk reads records) and words.
func Parse(text string) *Manifest {
	m := &Manifest{Text: text}
	rest := text
	for rest != "" {
		l, r, found := strings.Cut(rest, "\n")
		m.lines = append(m.lines, line{raw: l, words: textutil.Fields(l)})
		if !found {
			break
		}
		rest = r
	}
	return m
}

// HasHeader: the first line is Header.
func (m *Manifest) HasHeader() bool {
	first, _, _ := strings.Cut(m.Text, "\n")
	return first == Header
}

func (l line) word(i int) string {
	if i < len(l.words) {
		return l.words[i]
	}
	return ""
}

func (l line) key() string { return l.word(0) }

// Field is word f (1-based, as awk's $f) of the first `key` line: anywhere when cell is "",
// else after a `cell N` line whose N is cell (compared as awk compares: "01" is 1).
func (m *Manifest) Field(key, cell string, f int) string {
	c := ""
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
		}
		if l.key() == key && (cell == "" || textutil.AwkEqual(c, cell)) {
			return l.word(f - 1)
		}
	}
	return ""
}

// Has: some line has the key (in the cell, or anywhere when cell is "").
func (m *Manifest) Has(key, cell string) bool {
	c := ""
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
		}
		if l.key() == key && (cell == "" || textutil.AwkEqual(c, cell)) {
			return true
		}
	}
	return false
}

// All is word f of every `key` line (in the cell, or anywhere when cell is ""), empty words
// left out (they vanished in the shell's word splitting).
func (m *Manifest) All(key, cell string, f int) []string {
	var out []string
	c := ""
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
		}
		if l.key() == key && (cell == "" || textutil.AwkEqual(c, cell)) {
			if w := l.word(f - 1); w != "" {
				out = append(out, w)
			}
		}
	}
	return out
}

// Pair is a `KEY NAME VALUE` item.
type Pair struct{ Name, Value string }

// Env is the cell's `env NAME BASE64` items, in order.
func (m *Manifest) Env(cell string) []Pair {
	var out []Pair
	c := ""
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
		}
		if l.key() == "env" && textutil.AwkEqual(c, cell) {
			out = append(out, Pair{l.word(1), l.word(2)})
		}
	}
	return out
}

// Param is the base64 pattern of the first `param NAME` line, "" when there is none.
func (m *Manifest) Param(name string) string {
	for _, l := range m.lines {
		if l.key() == "param" && textutil.AwkEqual(l.word(1), name) {
			return l.word(2)
		}
	}
	return ""
}

// Step is the k-th `step` item of the cell (0-based), "" when there is none. (The count starts
// again at every `cell` line, as the shell gate's awk counted.)
func (m *Manifest) Step(cell string, k int) string {
	c := ""
	i := 0
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
			i = 0
		}
		if l.key() == "step" && textutil.AwkEqual(c, cell) {
			if i == k {
				return l.word(1)
			}
			i++
		}
	}
	return ""
}

// LastStep is the index of the cell's last step (-1 for none), counted as Step counts.
func (m *Manifest) LastStep(cell string) int {
	c := ""
	n := 0
	for _, l := range m.lines {
		if l.key() == "cell" {
			c = l.word(1)
		}
		if l.key() == "step" && textutil.AwkEqual(c, cell) {
			n++
		}
	}
	return n - 1
}

// Cells is the N of every `cell N` line, in order.
func (m *Manifest) Cells() []string { return m.All("cell", "", 2) }

// Duplicate is the first of name, version, expires and scope found a second time, "" when each
// is there at most once. As core's parseManifest reads it: once each (this gate reads the first
// one, core refuses a second; security review, 2026-11-16).
func (m *Manifest) Duplicate() string {
	seen := map[string]bool{}
	for _, l := range m.lines {
		switch k := l.key(); k {
		case "name", "version", "expires", "scope":
			if seen[k] {
				return k
			}
			seen[k] = true
		}
	}
	return ""
}

// Scopes is the first `scope` line after its key (its words: the scopes), "" for none.
func (m *Manifest) Scopes() string {
	for _, l := range m.lines {
		if l.key() == "scope" {
			s := l.raw
			// sub(/^scope +/, ""): only at the very start, and only before spaces.
			if strings.HasPrefix(s, "scope ") {
				s = strings.TrimLeft(s[len("scope"):], " ")
			}
			return s
		}
	}
	return ""
}

// Names is $2 of every `param` and `env` line: the names a runbook sets.
func (m *Manifest) Names() []string {
	var out []string
	for _, l := range m.lines {
		if k := l.key(); k == "param" || k == "env" {
			if w := l.word(1); w != "" {
				out = append(out, w)
			}
		}
	}
	return out
}

// KubeWant is the last kube-context= of a fence info string (kubeValues reads them as core's
// tokenizeInfo does), trimmed of ASCII blanks; ok is false when there is none. Check refuses a
// manifest whose info has two, or one that is neither a context name nor ${param:NAME}
// (KubeContext).
func KubeWant(info string) (want string, ok bool) {
	// (awk read the text as lines: one newline at its end was not part of it.)
	values := kubeValues(strings.TrimSuffix(info, "\n"))
	if len(values) == 0 {
		return "", false
	}
	return strings.Trim(values[len(values)-1], asciiBlanks), true
}
