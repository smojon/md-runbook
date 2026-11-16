// Package textutil holds the small text rules the gate shares: how it trims, splits and checks
// words, and how it quotes text for JSON and for the cells' shell. The shell gate read requests
// and manifests with the shell's and awk's word splitting (blanks: space and tab); these keep that
// reading, byte for byte (the gate's checks ran in the C locale).
package textutil

import (
	"strconv"
	"strings"
)

// Trim removes leading and trailing spaces, tabs and CRs (the shell gate's trim).
func Trim(s string) string { return strings.Trim(s, " \t\r") }

// Fields splits s at runs of spaces, tabs and newlines, as the shell's default IFS and awk's
// default FS do. Other bytes (a CR, invalid UTF-8) stay inside a word.
func Fields(s string) []string {
	var out []string
	start := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' {
			if start >= 0 {
				out = append(out, s[start:i])
				start = -1
			}
			continue
		}
		if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		out = append(out, s[start:])
	}
	return out
}

func allIn(s string, ok func(c byte) bool) bool {
	for i := 0; i < len(s); i++ {
		if !ok(s[i]) {
			return false
		}
	}
	return true
}

func isDigit(c byte) bool    { return c >= '0' && c <= '9' }
func isHexLower(c byte) bool { return isDigit(c) || (c >= 'a' && c <= 'f') }
func isAlpha(c byte) bool    { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }

// IsID: a request id, 1 to 64 lower-case hex digits.
func IsID(s string) bool { return s != "" && len(s) <= 64 && allIn(s, isHexLower) }

// IsNum: a whole number of at most 6 digits without leading zeros (cells, steps, versions).
// (No leading zeros: the shell read 08 as octal, or as an error.)
func IsNum(s string) bool { return isWhole(s, 6) }

// IsMiB: a whole number of MiB, at most 7 digits, without leading zeros.
func IsMiB(s string) bool { return isWhole(s, 7) }

func isWhole(s string, max int) bool {
	if s == "" || len(s) > max || !allIn(s, isDigit) {
		return false
	}
	return s == "0" || s[0] != '0'
}

// IsPID: a process id, 1 to 10 digits, not starting with 0.
func IsPID(s string) bool {
	return s != "" && len(s) <= 10 && s[0] != '0' && allIn(s, isDigit)
}

// IsVar: a shell variable name.
func IsVar(s string) bool {
	if s == "" || isDigit(s[0]) {
		return false
	}
	return allIn(s, func(c byte) bool { return isAlpha(c) || isDigit(c) || c == '_' })
}

// IsB64: only base64 characters (empty is fine: an empty value).
func IsB64(s string) bool {
	return allIn(s, func(c byte) bool { return isAlpha(c) || isDigit(c) || c == '+' || c == '/' || c == '=' })
}

// IsOneLine: a parameter value the gate takes: no CR, LF or NUL (core's isOneLineValue).
func IsOneLine(s string) bool { return !strings.ContainsAny(s, "\r\n\x00") }

// IsHex64: a sha256 in lower-case hex.
func IsHex64(s string) bool { return len(s) == 64 && allIn(s, isHexLower) }

// JSON quotes s as a JSON string the way the shell gate did: backslashes and double quotes
// escaped, control characters (bytes 0 to 31) dropped, every other byte as it is.
func JSON(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\':
			b.WriteString(`\\`)
		case c == '"':
			b.WriteString(`\"`)
		case c < 0x20:
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// SQ quotes s for a POSIX shell in single quotes. As the shell gate's sq (a command
// substitution), trailing newlines are dropped.
func SQ(s string) string {
	s = strings.TrimRight(s, "\n")
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Cut returns at most n bytes of s (cut -c in the C locale).
func Cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// ASCIILower lower-cases A-Z only (awk's tolower in the C locale).
func ASCIILower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// AwkEqual compares two awk fields or variables as awk does: as numbers when both look like
// numbers, else as strings. ("cell 01" is cell 1 to awk, as to core's Number().)
func AwkEqual(a, b string) bool {
	x, okA := awkNumber(a)
	y, okB := awkNumber(b)
	if okA && okB {
		return x == y
	}
	return a == b
}

// awkNumber reads s as awk reads a numeric string: blanks around a decimal number with an
// optional sign, fraction and exponent.
func awkNumber(s string) (float64, bool) {
	t := strings.Trim(s, " \t\n")
	if t == "" {
		return 0, false
	}
	i := 0
	if t[i] == '+' || t[i] == '-' {
		i++
	}
	digits := 0
	for i < len(t) && isDigit(t[i]) {
		i++
		digits++
	}
	if i < len(t) && t[i] == '.' {
		i++
		for i < len(t) && isDigit(t[i]) {
			i++
			digits++
		}
	}
	if digits == 0 {
		return 0, false
	}
	if i < len(t) && (t[i] == 'e' || t[i] == 'E') {
		j := i + 1
		if j < len(t) && (t[j] == '+' || t[j] == '-') {
			j++
		}
		k := j
		for k < len(t) && isDigit(t[k]) {
			k++
		}
		if k == j {
			return 0, false
		}
		i = k
	}
	if i != len(t) {
		return 0, false
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		// Out of range: awk still reads it as a number (inf); the text decides then.
		return 0, false
	}
	return f, true
}
