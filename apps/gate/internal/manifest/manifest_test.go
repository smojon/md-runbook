package manifest

import (
	"reflect"
	"testing"
)

// A manifest as core's formatManifest writes it (version 2: with text).
const sample = "md-runbook-manifest 1\n" +
	"name ops/test\n" +
	"version 3\n" +
	"expires 2030-01-01\n" +
	"scope web staging\n" +
	"text " + "ab0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd" + "\n" +
	"param TARGET W2Etel1bYS16MC05LV17MCwzMH0=\n" +
	"cell 1 all\ninfo YmFzaA==\ncode ZWNobyBvbmU=\n" +
	"cell 2 any\ninfo YmFzaCBrdWJlLWNvbnRleHQ9cHJvZA==\ncode ZWNobyBhCmVjaG8gYg==\nneeds TARGET\ncwd L3RtcA==\nenv GREETING aGVsbG8=\nenv OTHER eA==\nstep ZWNobyBh\nstep ZWNobyBi\n" +
	"call 1\ncallinfo cnVuYm9vaw==\ncallbody eA==\ncallneeds TARGET\n" +
	"end\n"

func TestFields(t *testing.T) {
	m := Parse(sample)
	if !m.HasHeader() {
		t.Fatal("no header")
	}
	for _, c := range []struct {
		key, cell string
		f         int
		want      string
	}{
		{"name", "", 2, "ops/test"},
		{"version", "", 2, "3"},
		{"expires", "", 2, "2030-01-01"},
		{"cell", "1", 3, "all"},
		{"cell", "2", 3, "any"},
		{"cell", "3", 3, ""},
		{"code", "1", 2, "ZWNobyBvbmU="},
		{"code", "2", 2, "ZWNobyBhCmVjaG8gYg=="},
		{"code", "01", 2, "ZWNobyBvbmU="},
		{"cwd", "1", 2, ""},
		{"cwd", "2", 2, "L3RtcA=="},
		{"info", "2", 2, "YmFzaCBrdWJlLWNvbnRleHQ9cHJvZA=="},
	} {
		if got := m.Field(c.key, c.cell, c.f); got != c.want {
			t.Errorf("Field(%s, %q, %d) = %q, want %q", c.key, c.cell, c.f, got, c.want)
		}
	}
	if got := m.All("needs", "2", 2); !reflect.DeepEqual(got, []string{"TARGET"}) {
		t.Errorf("needs: %q", got)
	}
	if got := m.Env("2"); !reflect.DeepEqual(got, []Pair{{"GREETING", "aGVsbG8="}, {"OTHER", "eA=="}}) {
		t.Errorf("env: %q", got)
	}
	if m.Param("TARGET") != "W2Etel1bYS16MC05LV17MCwzMH0=" || m.Param("OTHER") != "" {
		t.Error("param")
	}
	if m.Step("2", 0) != "ZWNobyBh" || m.Step("2", 1) != "ZWNobyBi" || m.Step("2", 2) != "" || m.Step("1", 0) != "" {
		t.Error("step")
	}
	if m.LastStep("2") != 1 || m.LastStep("1") != -1 {
		t.Error("last step")
	}
	if got := m.Cells(); !reflect.DeepEqual(got, []string{"1", "2"}) {
		t.Errorf("cells: %q", got)
	}
	if m.Scopes() != "web staging" {
		t.Errorf("scopes: %q", m.Scopes())
	}
	if got := m.Names(); !reflect.DeepEqual(got, []string{"TARGET", "GREETING", "OTHER"}) {
		t.Errorf("names: %q", got)
	}
	if m.Duplicate() != "" {
		t.Error("duplicate")
	}
}

func TestHeaderAndDuplicates(t *testing.T) {
	for text, ok := range map[string]bool{
		"md-runbook-manifest 1\nend\n": true,
		"md-runbook-manifest 1":        true,
		"md-runbook-manifest 2\nend\n": false,
		"md-runbook-manifest 1 \n":     false,
		"\nmd-runbook-manifest 1\n":    false,
	} {
		if Parse(text).HasHeader() != ok {
			t.Errorf("HasHeader(%q) != %v", text, ok)
		}
	}
	for text, want := range map[string]string{
		"md-runbook-manifest 1\nversion 1\nversion 9\n":      "version",
		"md-runbook-manifest 1\nname a\nscope x\nscope y\n":  "scope",
		"md-runbook-manifest 1\nexpires a\nname a\nname b\n": "name",
		"md-runbook-manifest 1\nname a\nversion 1\ncell 1\n": "",
	} {
		if got := Parse(text).Duplicate(); got != want {
			t.Errorf("Duplicate(%q) = %q", text, got)
		}
	}
}

func TestScopes(t *testing.T) {
	for text, want := range map[string]string{
		"scope web\n":        "web",
		"scope   web  x\n":   "web  x",
		"scope\n":            "scope",
		"  scope web\n":      "  scope web",
		"name x\n":           "",
		"scope a\nscope b\n": "a",
	} {
		if got := Parse("md-runbook-manifest 1\n" + text).Scopes(); got != want {
			t.Errorf("Scopes(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestKubeWant(t *testing.T) {
	for _, c := range []struct {
		info, want string
		ok         bool
	}{
		{"bash", "", false},
		{"bash kube-context=prod-eu", "prod-eu", true},
		{`bash Kube-Context="prod eu" x=1`, "prod eu", true},
		{"bash kube-context='lab-1'", "lab-1", true},
		{"bash kube-context=a kube-context=b", "b", true},
		{"bash {kube-context=hidden} env.X=1", "", false},
		{"bash{.class} kube-context=x", "x", true},
		{"bash kube-context=${param:CTX}", "${param:CTX}", true},
		{"bash kube-context=", "", true},
		{`bash kube-context="unterminated`, "unterminated", true},
		{"bash kube-context= \t", "", true},
		{"bash kubecontext=x", "", false},
		{"kube-context=x", "", false},
		{"  bash   kube-context=x\n", "x", true},
	} {
		got, ok := KubeWant(c.info)
		if got != c.want || ok != c.ok {
			t.Errorf("KubeWant(%q) = %q %v, want %q %v", c.info, got, ok, c.want, c.ok)
		}
	}
}
