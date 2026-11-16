// Package ere matches whole values against POSIX extended regular expressions as the shell gate's
// `grep -Eqx -e PATTERN` did in the C locale: byte by byte, POSIX bracket expressions (a
// backslash in brackets is a backslash), one alternative per line of the pattern. It compiles with
// regexp.CompilePOSIX, after rewriting what Go's parser reads otherwise than POSIX:
//   - every byte is one character (C locale): bytes 0x80 to 0xFF become the runes U+0080 to
//     U+00FF on both sides, so `.` matches one byte, never a whole UTF-8 sequence;
//   - bracket expressions are rewritten for Go: [\] is a backslash, []a] and [^]a] start with a
//     literal ], [[=a=]] and [[.a.]] name single bytes;
//   - a backslash before an ordinary character is that character (grep's "stray \"), except
//     GNU's extensions (\w, \s, \b, \<, \1 and the like) and anything Go reads otherwise: those
//     are errors, so the value is refused. Signing refuses them too (core's NOT_POSIX_ERE).
//
// Where Go and grep still differ ((? groups, {,n}, [:word:], a repetition with nothing before
// it), the pattern is refused: no value matches, which fails closed.
package ere

import (
	"errors"
	"regexp"
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
		re, err := regexp.CompilePOSIX("^(" + t + ")$")
		if err != nil {
			return nil, err
		}
		p.alts = append(p.alts, re)
	}
	return p, nil
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

// Characters special outside brackets in a POSIX ERE.
const special = `.[]()*+?{}|^$\`

func literal(c byte) string {
	if c >= 0x80 {
		return string(rune(c))
	}
	if strings.IndexByte(special, c) >= 0 {
		return `\` + string(c)
	}
	return string(c)
}

func translate(src string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\\':
			if i+1 >= len(src) {
				return "", errPattern // a trailing backslash: grep refuses it
			}
			d := src[i+1]
			switch {
			case strings.IndexByte(special, d) >= 0:
				out.WriteString(`\` + string(d))
			case strings.IndexByte("dDwWsSbB<>`'123456789", d) >= 0:
				return "", errPattern
			default:
				out.WriteString(literal(d))
			}
			i += 2
		case c == '[':
			cls, n, err := bracket(src[i:])
			if err != nil {
				return "", err
			}
			out.WriteString(cls)
			i += n
		// Go reads (?i) as flags and {,n} as text; grep reads (? as ( and a stray ?, and {,n} as
		// {0,n}. Either way a pattern that means one thing to grep and another to Go: refused,
		// so no value matches more than it would have (signing refuses (? too).
		case (c == '(' && i+1 < len(src) && src[i+1] == '?') || (c == '{' && i+1 < len(src) && src[i+1] == ','):
			return "", errPattern
		case c >= 0x80:
			out.WriteString(literal(c))
			i++
		default:
			out.WriteByte(c)
			i++
		}
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
	if c >= 0x80 {
		return string(rune(c))
	}
	if strings.IndexByte(`\]-[^`, c) >= 0 {
		return `\` + string(c)
	}
	return string(c)
}

// bracket reads the bracket expression at the start of s ("[...]") and returns its Go form and
// its length in s.
func bracket(s string) (string, int, error) {
	i := 1
	neg := false
	if i < len(s) && s[i] == '^' {
		neg = true
		i++
	}
	var items []item
	first := true
	for {
		if i >= len(s) {
			return "", 0, errPattern // unterminated
		}
		c := s[i]
		if c == ']' && !first {
			i++
			break
		}
		first = false
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
			// [=a=] and [.a.]: a single byte in the C locale.
			if len(name) != 1 {
				return "", 0, errPattern
			}
			items = append(items, item{b: name[0]})
			continue
		}
		items = append(items, item{b: c})
		i++
	}
	var out strings.Builder
	out.WriteByte('[')
	if neg {
		out.WriteByte('^')
	}
	for k := 0; k < len(items); k++ {
		it := items[k]
		if it.class != "" {
			out.WriteString("[:" + it.class + ":]")
			continue
		}
		// A range: a byte, '-', a byte (a '-' first or last is a literal one).
		if k+2 < len(items) && items[k+1].class == "" && items[k+1].b == '-' && items[k+2].class == "" {
			lo, hi := it.b, items[k+2].b
			if lo > hi {
				return "", 0, errPattern
			}
			out.WriteString(classLiteral(lo) + "-" + classLiteral(hi))
			k += 2
			continue
		}
		out.WriteString(classLiteral(it.b))
	}
	out.WriteByte(']')
	return out.String(), i, nil
}
