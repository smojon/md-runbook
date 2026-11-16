package manifest

import (
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/smojon/md-runbook/apps/gate/internal/ere"
	"github.com/smojon/md-runbook/apps/gate/internal/names"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Check reads the manifest as core's parseManifest does (packages/core/src/signing.ts), and
// refuses what it refuses: only the form formatManifest writes. Each item once where it can only be
// once, in formatManifest's order; words of printable ASCII one space apart; canonical base64 of
// UTF-8 text; names a runbook may set; cells and calls numbered 1, 2, ...; a cell's kube-context=
// readable (KubeContext); `end` and nothing after it. Before, this gate read the first of two items
// where clients read the last (two `param X` lines, two `code` lines, cells numbered alike), and
// read what followed `end` (gate vectors, apps/gate/testdata/vectors.json, 2026-11-16). After
// Check, Field, Param, Env and Step read what core's parseManifest reads.
func Check(text string) error {
	lines := strings.Split(text, "\n")
	if lines[0] != Header {
		return errors.New("not an md-runbook manifest (or a newer version)")
	}
	patterns := map[string]bool{}
	once := map[string]bool{}
	at := -1
	inner := 0
	cells, calls := 0, 0
	inCell, inCall := false, false
	var cellNeeds, cellEnv, callNeeds map[string]bool
	close := func() error {
		if inCell && inner < 2 {
			return errors.New("manifest: cell " + strconv.Itoa(cells) + " has no " + pick(inner < 1, "info", "code"))
		}
		if inCall && inner < 2 {
			return errors.New("manifest: call " + strconv.Itoa(calls) + " has no " + pick(inner < 1, "callinfo", "callbody"))
		}
		return nil
	}
	ended := false
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if ended {
			if line != "" || i != len(lines)-1 {
				return errors.New("manifest: text after end")
			}
			continue
		}
		if line == "" {
			if i == len(lines)-1 {
				return errors.New("manifest: no end")
			}
			return errors.New("manifest: an empty line")
		}
		for j := 0; j < len(line); j++ {
			if line[j] < 0x20 || line[j] > 0x7e {
				return errors.New("manifest: line " + strconv.Itoa(i+1) + " has a character other than printable ASCII")
			}
		}
		words := strings.Split(line, " ")
		key, args := words[0], words[1:]
		switch key {
		case "name", "version", "expires", "scope", "text":
			if once[key] {
				return errors.New("manifest: more than one " + key + " line")
			}
			once[key] = true
		}
		want, known := itemWords[key]
		if !known && key != "scope" {
			return errors.New("manifest: unknown item")
		}
		if (key == "scope" && len(args) == 0) || (key != "scope" && len(args) != want) {
			return errors.New("manifest: bad line")
		}
		a, b := "", ""
		if len(args) > 0 {
			a = args[0]
		}
		if len(args) > 1 {
			b = args[1]
		}
		if top := indexOf(itemOrder, key); top >= 0 {
			if top < at || (top == at && key != "param" && key != "cell" && key != "call") {
				return errors.New("manifest: " + key + " out of order")
			}
			if err := close(); err != nil {
				return err
			}
			at, inner = top, 0
			inCell, inCall = false, false
		} else {
			order := callOrder
			if indexOf(cellOrder, key) >= 0 {
				order = cellOrder
				if !inCell {
					return errors.New("manifest: " + key + " outside a cell")
				}
			} else if !inCall {
				return errors.New("manifest: " + key + " outside a call")
			}
			k := indexOf(order, key) + 1
			if k > 2 && inner < 2 {
				if err := close(); err != nil {
					return err
				}
			}
			if (k <= 2 && k != inner+1) || (k > 2 && (k < inner || (k == inner && key == "cwd"))) {
				return errors.New("manifest: " + key + " out of order")
			}
			inner = k
		}
		switch key {
		case "name":
			if !isRunbookName(a) {
				return errors.New("manifest: bad name")
			}
		case "version":
			if !textutil.IsNum(a) || a == "0" {
				return errors.New("manifest: bad version (expected a whole number)")
			}
		case "expires":
			if !IsDate(a) {
				return errors.New("manifest: bad expires (expected YYYY-MM-DD)")
			}
		case "scope":
			seen := map[string]bool{}
			for _, s := range args {
				if !isScope(s) || seen[s] {
					return errors.New("manifest: bad scope")
				}
				seen[s] = true
			}
		case "text":
			if !textutil.IsHex64(a) {
				return errors.New("manifest: bad text")
			}
		case "param":
			if err := settable(a, "param"); err != nil {
				return err
			}
			if patterns[a] {
				return errors.New("manifest: more than one param " + a)
			}
			re, err := value(b, "pattern", true)
			if err != nil {
				return err
			}
			if re == "" {
				return errors.New("manifest: empty pattern for " + a)
			}
			// Only the subset grep, the gate and clients read alike (core's signedPatternProblem).
			if _, err := ere.Compile(re); err != nil {
				return errors.New("manifest: the pattern for " + a + " is not one the gate reads")
			}
			patterns[a] = true
		case "cell":
			if a != strconv.Itoa(cells+1) || (b != "all" && b != "any") {
				return errors.New("manifest: bad line")
			}
			cells++
			inCell = true
			cellNeeds, cellEnv = map[string]bool{}, map[string]bool{}
		case "info":
			info, err := value(a, "info", true)
			if err != nil {
				return err
			}
			want, _, problem := KubeContext(info)
			if problem != "" {
				return errors.New("manifest: cell " + strconv.Itoa(cells) + ": " + problem)
			}
			if p, ok := kubeParam(want); ok && !patterns[p] {
				return errors.New("manifest: cell " + strconv.Itoa(cells) + "'s kube-context parameter " + p + " has no param line")
			}
		case "code", "step", "callbody":
			if _, err := value(a, key, false); err != nil {
				return err
			}
		case "needs":
			if cellNeeds[a] {
				return errors.New("manifest: cell " + strconv.Itoa(cells) + " needs " + a + " twice")
			}
			if !patterns[a] {
				return errors.New("manifest: needs " + a + " has no param line")
			}
			cellNeeds[a] = true
		case "cwd":
			cwd, err := value(a, "cwd", true)
			if err != nil {
				return err
			}
			if cwd == "" {
				return errors.New("manifest: bad cwd (empty)")
			}
		case "env":
			if err := settable(a, "env"); err != nil {
				return err
			}
			if cellEnv[a] {
				return errors.New("manifest: cell " + strconv.Itoa(cells) + " sets env " + a + " twice")
			}
			if _, err := value(b, "env", true); err != nil {
				return err
			}
			cellEnv[a] = true
		case "call":
			if a != strconv.Itoa(calls+1) {
				return errors.New("manifest: bad line")
			}
			calls++
			inCall = true
			callNeeds = map[string]bool{}
		case "callinfo":
			if _, err := value(a, "callinfo", true); err != nil {
				return err
			}
		case "callneeds":
			if callNeeds[a] {
				return errors.New("manifest: call " + strconv.Itoa(calls) + " needs " + a + " twice")
			}
			if !patterns[a] {
				return errors.New("manifest: callneeds " + a + " has no param line")
			}
			callNeeds[a] = true
		case "end":
			ended = true
		}
	}
	// `end` and its newline, as formatManifest writes it.
	if !ended || !strings.HasSuffix(text, "\n") {
		return errors.New("manifest: no end")
	}
	if !once["name"] || !once["version"] {
		return errors.New("manifest: bad name or version")
	}
	return nil
}

var itemWords = map[string]int{
	"name": 1, "version": 1, "expires": 1, "text": 1, "param": 2, "cell": 2, "info": 1, "code": 1, "needs": 1, "cwd": 1, "env": 2, "step": 1,
	"call": 1, "callinfo": 1, "callbody": 1, "callneeds": 1, "end": 0,
}

var (
	itemOrder = []string{"name", "version", "expires", "scope", "text", "param", "cell", "call", "end"}
	cellOrder = []string{"info", "code", "needs", "cwd", "env", "step"}
	callOrder = []string{"callinfo", "callbody", "callneeds"}
)

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

func pick(c bool, a, b string) string {
	if c {
		return a
	}
	return b
}

// settable: a name a runbook may set (a param or env name).
func settable(name, what string) error {
	if !textutil.IsVar(name) || names.IsReserved(name) {
		return errors.New("manifest: " + what + " " + name + ": a name the gate doesn't let a runbook set")
	}
	return nil
}

// value decodes a base64 word as core's fromBase64 does: canonical padded base64 of UTF-8 text (a
// BOM at its start is no such text: TextDecoder drops it), without NUL; oneLine: nor a line break.
func value(b64, what string, oneLine bool) (string, error) {
	raw, err := base64.StdEncoding.Strict().DecodeString(b64)
	if err != nil || base64.StdEncoding.EncodeToString(raw) != b64 || !utf8.Valid(raw) || strings.HasPrefix(string(raw), "\xef\xbb\xbf") {
		return "", errors.New("manifest: bad " + what)
	}
	s := string(raw)
	bad := "\x00"
	if oneLine {
		bad = "\r\n\x00"
	}
	if strings.ContainsAny(s, bad) {
		return "", errors.New("manifest: bad " + what + " (a line break or NUL in it)")
	}
	return s, nil
}

// isRunbookName: core's RUNBOOK_NAME_RE, ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$.
func isRunbookName(s string) bool {
	return wordOf(s, 100, "._/-")
}

// isScope: core's SCOPE_RE, ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.
func isScope(s string) bool {
	return wordOf(s, 64, "._-")
}

func wordOf(s string, max int, more string) bool {
	if s == "" || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		alnum := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
		if !alnum && (i == 0 || strings.IndexByte(more, c) < 0) {
			return false
		}
	}
	return true
}

// IsDate: YYYY-MM-DD, a real calendar day, as core's isDate reads it (2026-02-31 is none: the
// gate compares dates as text, and such a date would never expire).
func IsDate(s string) bool {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return false
	}
	for _, i := range []int{0, 1, 2, 3, 5, 6, 8, 9} {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	t, err := time.Parse("2006-01-02", s)
	return err == nil && t.Format("2006-01-02") == s
}

// asciiBlanks: what core's INFO_LANG_RE and asciiTrim take as blanks.
const asciiBlanks = " \t\n\r\f\v"

// kubeParam: NAME of a kube-context of ${param:NAME}.
func kubeParam(want string) (string, bool) {
	if strings.HasPrefix(want, "${param:") && strings.HasSuffix(want, "}") && len(want) > len("${param:}") {
		p := want[len("${param:") : len(want)-1]
		return p, textutil.IsVar(p)
	}
	return "", false
}

// KubeContext is a cell's kube-context= as core's gateKubeContext reads it
// (packages/core/src/cellOptions.ts): has is false when there is none; problem is set when its
// value is neither a context name nor ${param:NAME}, or kube-context= is written twice. The value is
// trimmed of ASCII blanks.
func KubeContext(info string) (want string, has bool, problem string) {
	values := kubeValues(info)
	switch len(values) {
	case 0:
		return "", false, ""
	case 1:
	default:
		return "", true, "kube-context= written twice"
	}
	want = strings.Trim(values[0], asciiBlanks)
	if _, ok := kubeParam(want); ok || IsKubeName(want) {
		return want, true, ""
	}
	return "", true, "kube-context=" + values[0] + ": expected a Kubernetes context name or ${param:NAME}"
}

// IsKubeName: core's isKubeContextName, ^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$ and at most 253 bytes.
func IsKubeName(s string) bool {
	return wordOf(s, 253, "._:@/+-")
}

// kubeValues: the value of every kube-context= option of an info string, read as core's
// tokenizeInfo reads it: after the language word (up to an ASCII blank or a {), key=value,
// key="quoted" or key='quoted', bare flags, {...} skipped, keys in any case as JavaScript's
// toLowerCase reads them (the Kelvin sign K is a k).
func kubeValues(info string) []string {
	s := strings.TrimLeft(info, asciiBlanks)
	i := 0
	for i < len(s) && strings.IndexByte(" \t\n\r\f\v{", s[i]) < 0 {
		i++
	}
	s = s[i:]
	n := len(s)
	i = 0
	var out []string
	for i < n {
		for i < n && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= n {
			break
		}
		if s[i] == '{' {
			j := strings.IndexByte(s[i:], '}')
			if j < 0 {
				i = n
			} else {
				i += j + 1
			}
			continue
		}
		st := i
		for i < n && s[i] != ' ' && s[i] != '\t' && s[i] != '=' {
			i++
		}
		key := s[st:i]
		if i >= n || s[i] != '=' {
			continue
		}
		i++
		var v string
		if i < n && (s[i] == '"' || s[i] == '\'') {
			q := s[i]
			j := strings.IndexByte(s[i+1:], q)
			if j < 0 {
				v = s[i+1:]
				i = n
			} else {
				v = s[i+1 : i+1+j]
				i += j + 2
			}
		} else {
			vs := i
			for i < n && s[i] != ' ' && s[i] != '\t' {
				i++
			}
			v = s[vs:i]
		}
		if key != "" && jsLower(key) == "kube-context" {
			out = append(out, v)
		}
	}
	return out
}

// jsLower lower-cases s as JavaScript's String.prototype.toLowerCase does for the keys compared
// here: Unicode's simple mapping, except that İ (U+0130) becomes i and a combining dot (so it never
// reads as an ASCII i).
func jsLower(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == 0x130 {
			b.WriteString("i̇")
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}
