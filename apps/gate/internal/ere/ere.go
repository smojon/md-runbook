// Package ere matches whole values against the POSIX extended regular expressions signed runbooks
// give their parameters, byte by byte as the shell gate's `grep -Eqx -e PATTERN` did in the C
// locale (bytes 0x80 to 0xFF become the runes U+0080 to U+00FF on both sides, so `.` matches one
// byte, never a whole UTF-8 sequence).
//
// Only the subset that grep, this gate and the clients (core's signedPattern.ts) read the same way
// compiles; anything else is refused, so no value matches (fail closed), and signing refuses it
// too:
//   - outside brackets, a backslash only before one of .[]()*+?{}|^$\ (before, \t was a t here
//     and a tab to clients);
//   - parentheses balanced, no (? : a signed `a)|(b` became ^(a)|(b)$ and matched any value
//     starting with a (review of 0.28.0, M1). The translated pattern also compiles on its own,
//     and the wrapper's group is checked to be the whole expression;
//   - a repetition (* + ? {m,n}) only after something it repeats and never right after another;
//     {m}, {m,} and {m,n} with m <= n <= 255, no other { or }, no ] outside brackets;
//   - in brackets: printable ASCII without a backslash (a backslash was one here and an escape to
//     clients, M2), POSIX classes, [=c=], [.c.], ranges low to high; not [:alpha:] alone, which
//     grep refused;
//   - no control character.
package ere

import (
	"errors"
	"regexp"
	"regexp/syntax"
	"strconv"
	"strings"
)

// Pattern is a compiled pattern: one expression per line of the source.
type Pattern struct{ alts []*regexp.Regexp }

// Compile compiles a pattern for whole-value matches.
func Compile(pattern string) (*Pattern, error) {
	p := &Pattern{}
	for _, alt := range strings.Split(pattern, "\n") {
		t, err := translate(alt)
		if err != nil {
			return nil, err
		}
		// On its own first: a pattern that only compiles inside the wrapper (a)|(b) is refused.
		if _, err := regexp.CompilePOSIX(t); err != nil {
			return nil, err
		}
		whole := "^(" + t + ")$"
		if !wrapped(whole) {
			return nil, errPattern
		}
		re, err := regexp.CompilePOSIX(whole)
		if err != nil {
			return nil, err
		}
		p.alts = append(p.alts, re)
	}
	return p, nil
}

// wrapped: the expression is ^, one group, $, and nothing beside them at the top.
func wrapped(whole string) bool {
	re, err := syntax.Parse(whole, syntax.POSIX)
	if err != nil || re.Op != syntax.OpConcat || len(re.Sub) != 3 {
		return false
	}
	begin, end := re.Sub[0].Op, re.Sub[2].Op
	return (begin == syntax.OpBeginText || begin == syntax.OpBeginLine) && re.Sub[1].Op == syntax.OpCapture && re.Sub[1].Cap == 1 &&
		(end == syntax.OpEndText || end == syntax.OpEndLine)
}

// MatchWhole: value, a single line, matches the whole pattern.
func (p *Pattern) MatchWhole(value string) bool {
	if strings.ContainsAny(value, "\n") {
		return false
	}
	v := bytesAsRunes(value)
	for _, re := range p.alts {
		if re.MatchString(v) {
			return true
		}
	}
	return false
}

// MatchWhole compiles pattern and matches value; a pattern that doesn't compile matches nothing.
func MatchWhole(pattern, value string) bool {
	p, err := Compile(pattern)
	if err != nil {
		return false
	}
	return p.MatchWhole(value)
}

// bytesAsRunes maps each byte to the rune of the same number.
func bytesAsRunes(s string) string {
	var b strings.Builder
	b.Grow(len(s) * 2)
	for i := 0; i < len(s); i++ {
		b.WriteRune(rune(s[i]))
	}
	return b.String()
}

var errPattern = errors.New("not a POSIX extended regular expression this gate reads")

// Characters special outside brackets in a POSIX ERE: a backslash only before one of these.
const special = `.[]()*+?{}|^$\`

// MaxRepeat is the largest repetition count ({m,n}).
const MaxRepeat = 255

// interval reads {m}, {m,} or {m,n} at the start of s: its length, ok false when it is none.
func interval(s string) (n int, ok bool) {
	end := strings.IndexByte(s, '}')
	if end < 0 {
		return 0, false
	}
	body := s[1:end]
	lo, hi, comma := body, "", false
	if i := strings.IndexByte(body, ','); i >= 0 {
		lo, hi, comma = body[:i], body[i+1:], true
	}
	count := func(d string) (int, bool) {
		if d == "" || len(d) > 3 || (len(d) > 1 && d[0] == '0') {
			return 0, false
		}
		for i := 0; i < len(d); i++ {
			if d[i] < '0' || d[i] > '9' {
				return 0, false
			}
		}
		v, _ := strconv.Atoi(d)
		return v, v <= MaxRepeat
	}
	l, ok := count(lo)
	if !ok {
		return 0, false
	}
	if comma && hi != "" {
		h, ok := count(hi)
		if !ok || h < l {
			return 0, false
		}
	}
	return end + 1, true
}

func translate(src string) (string, error) {
	var out strings.Builder
	depth := 0
	atom, repeated := false, false
	for i := 0; i < len(src); {
		c := src[i]
		if c < 0x20 || c == 0x7f {
			return "", errPattern
		}
		switch {
		case c == '\\':
			if i+1 >= len(src) || strings.IndexByte(special, src[i+1]) < 0 {
				return "", errPattern
			}
			out.WriteString(`\` + string(src[i+1]))
			i += 2
			atom, repeated = true, false
		case c == '[':
			cls, n, err := bracket(src[i:])
			if err != nil {
				return "", err
			}
			out.WriteString(cls)
			i += n
			atom, repeated = true, false
		case c == '*' || c == '+' || c == '?' || c == '{':
			n := 1
			if c == '{' {
				var ok bool
				if n, ok = interval(src[i:]); !ok {
					return "", errPattern
				}
			}
			if !atom || repeated {
				return "", errPattern
			}
			out.WriteString(src[i : i+n])
			i += n
			repeated = true
		case c == '}' || c == ']':
			return "", errPattern
		case c == '(':
			if i+1 < len(src) && src[i+1] == '?' {
				return "", errPattern
			}
			depth++
			out.WriteByte('(')
			i++
			atom, repeated = false, false
		case c == ')':
			if depth == 0 {
				return "", errPattern
			}
			depth--
			out.WriteByte(')')
			i++
			atom, repeated = true, false
		case c == '|' || c == '^' || c == '$':
			out.WriteByte(c)
			i++
			atom, repeated = false, false
		case c >= 0x80:
			out.WriteRune(rune(c))
			i++
			atom, repeated = true, false
		default:
			out.WriteByte(c)
			i++
			atom, repeated = true, false
		}
	}
	if depth != 0 {
		return "", errPattern
	}
	return out.String(), nil
}

var posixClasses = map[string]bool{
	"alnum": true, "alpha": true, "blank": true, "cntrl": true, "digit": true, "graph": true,
	"lower": true, "print": true, "punct": true, "space": true, "upper": true, "xdigit": true,
}

// An item of a bracket expression: one byte, or a named class ([:alpha:]).
type item struct {
	class string
	b     byte
}

func classLiteral(c byte) string {
	if strings.IndexByte(`\]-[^`, c) >= 0 {
		return `\` + string(c)
	}
	return string(c)
}

func printable(c byte) bool { return c >= 0x20 && c <= 0x7e }

// bracket reads the bracket expression at the start of s ("[...]") and returns its Go form and
// its length in s.
func bracket(s string) (string, int, error) {
	i := 1
	neg := false
	if i < len(s) && s[i] == '^' {
		neg = true
		i++
	}
	start := i
	var items []item
	for {
		if i >= len(s) {
			return "", 0, errPattern // unterminated
		}
		c := s[i]
		if c == ']' && i > start {
			i++
			break
		}
		if c == '\\' || !printable(c) {
			return "", 0, errPattern
		}
		if c == '[' && i+1 < len(s) && strings.IndexByte(":=.", s[i+1]) >= 0 {
			kind := s[i+1]
			end := strings.Index(s[i+2:], string(kind)+"]")
			if end < 0 {
				return "", 0, errPattern
			}
			name := s[i+2 : i+2+end]
			i += 2 + end + 2
			if kind == ':' {
				// POSIX's classes only (Go also knows [:word:], grep doesn't).
				if !posixClasses[name] {
					return "", 0, errPattern
				}
				items = append(items, item{class: name})
				continue
			}
			// [=a=] and [.a.]: one printable ASCII character, not a backslash.
			if len(name) != 1 || name[0] == '\\' || !printable(name[0]) {
				return "", 0, errPattern
			}
			items = append(items, item{b: name[0]})
			continue
		}
		items = append(items, item{b: c})
		i++
	}
	// [:alpha:] alone: grep refused it (the class is [[:alpha:]]).
	if body := s[start : i-1]; len(body) >= 2 && body[0] == ':' && body[len(body)-1] == ':' {
		return "", 0, errPattern
	}
	var out strings.Builder
	out.WriteByte('[')
	if neg {
		out.WriteByte('^')
	}
	for k := 0; k < len(items); k++ {
		it := items[k]
		// A range: an item, '-', an item (a '-' first or last is a literal one).
		if k+2 < len(items) && items[k+1].class == "" && items[k+1].b == '-' {
			hi := items[k+2]
			if it.class != "" || hi.class != "" || it.b > hi.b {
				return "", 0, errPattern
			}
			out.WriteString(classLiteral(it.b) + "-" + classLiteral(hi.b))
			k += 2
			continue
		}
		if it.class != "" {
			out.WriteString("[:" + it.class + ":]")
			continue
		}
		out.WriteString(classLiteral(it.b))
	}
	out.WriteByte(']')
	return out.String(), i, nil
}
