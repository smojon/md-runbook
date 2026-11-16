package textutil

import (
	"reflect"
	"testing"
)

func TestFields(t *testing.T) {
	cases := map[string][]string{
		"":                     nil,
		"  ":                   nil,
		"run 00000001 1":       {"run", "00000001", "1"},
		"\trun  a\t\tb ":       {"run", "a", "b"},
		"run 00000001 1\r":     {"run", "00000001", "1\r"},
		": mdrb-gate-hello x;": {":", "mdrb-gate-hello", "x;"},
	}
	for in, want := range cases {
		if got := Fields(in); !reflect.DeepEqual(got, want) {
			t.Errorf("Fields(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestChecks(t *testing.T) {
	type check struct {
		f    func(string) bool
		name string
		ok   []string
		bad  []string
	}
	for _, c := range []check{
		{IsID, "IsID", []string{"0", "feed0001", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}, []string{"", "FEED", "g", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0"}},
		{IsNum, "IsNum", []string{"0", "1", "999999"}, []string{"", "01", "1000000", "1a", "-1", " 1"}},
		{IsMiB, "IsMiB", []string{"0", "512", "9999999"}, []string{"0512", "10000000", "lots"}},
		{IsPID, "IsPID", []string{"1", "4194304", "9999999999"}, []string{"", "0", "01", "12345678901"}},
		{IsVar, "IsVar", []string{"A", "_x", "TARGET_1"}, []string{"", "1A", "A-B", "A B", "é"}},
		{IsB64, "IsB64", []string{"", "QUJD", "a+/="}, []string{"a b", "a-b", "a\n"}},
		{IsHex64, "IsHex64", []string{"ab" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"}, []string{"AB0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "ab"}},
	} {
		for _, s := range c.ok {
			if !c.f(s) {
				t.Errorf("%s(%q) = false", c.name, s)
			}
		}
		for _, s := range c.bad {
			if c.f(s) {
				t.Errorf("%s(%q) = true", c.name, s)
			}
		}
	}
}

func TestJSON(t *testing.T) {
	cases := map[string]string{
		"plain":           `"plain"`,
		`a"b\c`:           `"a\"b\\c"`,
		"two\nlines\x07":  `"twolines"`,
		"é \x7f":          "\"é \x7f\"",
		"$(touch x) `id`": "\"$(touch x) `id`\"",
	}
	for in, want := range cases {
		if got := JSON(in); got != want {
			t.Errorf("JSON(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestSQ(t *testing.T) {
	cases := map[string]string{
		"":          "''",
		"it's":      `'it'\''s'`,
		"$HOME\n\n": "'$HOME'",
	}
	for in, want := range cases {
		if got := SQ(in); got != want {
			t.Errorf("SQ(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestAwkEqual(t *testing.T) {
	for _, c := range []struct {
		a, b string
		eq   bool
	}{
		{"1", "1", true}, {"01", "1", true}, {"1.0", "1", true}, {"1e0", "1", true},
		{"1", "2", false}, {"a", "a", true}, {"", "0", false}, {"1a", "1", false}, {"ops/test", "ops/test", true},
	} {
		if got := AwkEqual(c.a, c.b); got != c.eq {
			t.Errorf("AwkEqual(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestTrimCutLower(t *testing.T) {
	if got := Trim(" \t x y\r\t "); got != "x y" {
		t.Errorf("Trim: %q", got)
	}
	if got := Cut("abcdef", 3); got != "abc" {
		t.Errorf("Cut: %q", got)
	}
	if got := ASCIILower("Kube-Context É"); got != "kube-context É" {
		t.Errorf("ASCIILower: %q", got)
	}
}
