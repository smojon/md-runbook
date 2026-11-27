package config

import (
	"strings"
	"testing"
)

func read(t *testing.T, text string) (Config, error) {
	t.Helper()
	c := Defaults()
	err := c.Read(strings.NewReader(text), "gate.conf")
	return c, err
}

func TestDefaults(t *testing.T) {
	c, err := read(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.Unsigned != "refuse" || c.Scopes != "*" || c.Signers != "1" || c.Log != "syslog" || c.MemoryLimit != "512" ||
		c.KillLeftovers != "no" || c.LoginShellCheck != "yes" || c.SSHDForceCommand || c.AllowNoGroupKill != "" ||
		c.AuthorizedKeys != "%h/.ssh/authorized_keys %h/.ssh/authorized_keys2" || c.Path != "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" {
		t.Errorf("defaults: %+v", c)
	}
}

func TestRead(t *testing.T) {
	c, err := read(t, "# policy\r\n unsigned = allow \r\nscopes = web staging # two\nscopes = web\nsigners=2\nlog = /var/log/gate.log\n"+
		"memory_limit = 0\nkill_leftovers = yes\nallow_no_group_kill = no\nsshd_force_command = yes\nno equals sign here\nreport_to = https://x.example.net/v1/runs")
	if err != nil {
		t.Fatal(err)
	}
	if c.Unsigned != "allow" || c.Scopes != "web" || c.Signers != "2" || c.Log != "/var/log/gate.log" || c.MemoryLimit != "0" ||
		c.KillLeftovers != "yes" || c.AllowNoGroupKill != "no" || !c.SSHDForceCommand || c.ReportTo != "https://x.example.net/v1/runs" {
		t.Errorf("read: %+v", c)
	}
	// A value with = in it keeps it; an empty scopes is read (and refused later).
	c, err = read(t, "path = /a:/b=c\nscopes =  # none\n")
	if err != nil || c.Path != "/a:/b=c" || c.Scopes != "" {
		t.Errorf("read: %+v %v", c, err)
	}
}

func TestReadFailsClosed(t *testing.T) {
	for text, want := range map[string]string{
		"unknown = 1\n":             `gate.conf: unknown setting "unknown"`,
		"= x\n":                     `gate.conf: unknown setting ""`,
		"kill_leftovers = maybe\n":  "kill_leftovers = maybe: expected yes or no",
		"allow_no_group_kill = 1\n": "allow_no_group_kill = 1: expected yes or no",
		"memory_limit = lots\n":     "memory_limit = lots: expected a number of MiB (0 for none)",
		"memory_limit = 0512\n":     "memory_limit = 0512: expected a number of MiB (0 for none)",
		"login_shell_check = on\n":  "login_shell_check = on: expected yes or no",
		"sshd_force_command = 1\n":  "sshd_force_command = 1: expected yes or no",
		"isolation = systemd\n":     "isolation = systemd: expected auto, scope, bwrap or none",
		"isolation =\n":             "isolation = : expected auto, scope, bwrap or none",
		"isolation = Scope\n":       "isolation = Scope: expected auto, scope, bwrap or none",
		"cells_account =\n":         "cells_account = : expected an account name (leave the line out to run the cells as the gate's account)",
		"cells_account = a b\n":     "cells_account = a b: expected an account name (leave the line out to run the cells as the gate's account)",
		"cells_account = $(id)\n":   "cells_account = $(id): expected an account name (leave the line out to run the cells as the gate's account)",
		"cells_account = -u\n":      "cells_account = -u: expected an account name (leave the line out to run the cells as the gate's account)",
	} {
		_, err := read(t, text)
		if err == nil || err.Error() != want {
			t.Errorf("%q: %v, want %s", text, err, want)
		}
	}
}

func TestIsolationAndCellsAccount(t *testing.T) {
	c, err := read(t, "")
	if err != nil || c.Isolation != "auto" || c.CellsAccount != "" {
		t.Errorf("defaults: %+v %v", c, err)
	}
	for _, v := range Isolations {
		c, err := read(t, "isolation = "+v+"\n")
		if err != nil || c.Isolation != v {
			t.Errorf("isolation = %s: %+v %v", v, c, err)
		}
	}
	c, err = read(t, "cells_account = mdrb-cells\nisolation = none\nisolation = scope # required\n")
	if err != nil || c.CellsAccount != "mdrb-cells" || c.Isolation != "scope" {
		t.Errorf("read: %+v %v", c, err)
	}
	for s, ok := range map[string]bool{"mdrb-cells": true, "_cells": true, "c.ells_1": true, "": false, "ALL": false, "All": true, "-x": false, "1cells": false, "a:b": false, "a/b": false, "abcdefghijklmnopqrstuvwxyz0123456": false} {
		if ValidAccount(s) != ok {
			t.Errorf("ValidAccount(%q) != %v", s, ok)
		}
	}
}

// cells_accounts: a pool, in gate.conf's order; cells_account is a pool of one; both is an error.
func TestCellsPool(t *testing.T) {
	c, err := read(t, "")
	if err != nil || c.CellsPool() != nil {
		t.Errorf("shared: %q %v", c.CellsPool(), err)
	}
	c, err = read(t, "cells_accounts = mdrb-cells-1 \t mdrb-cells-2 mdrb-cells-3 mdrb-cells-4 # four\n")
	if err != nil || strings.Join(c.CellsPool(), ",") != "mdrb-cells-1,mdrb-cells-2,mdrb-cells-3,mdrb-cells-4" || c.CellsKey() != "cells_accounts" {
		t.Errorf("pool: %q %v", c.CellsPool(), err)
	}
	c, err = read(t, "cells_account = mdrb-cells")
	if err != nil || strings.Join(c.CellsPool(), ",") != "mdrb-cells" || c.CellsKey() != "cells_account" {
		t.Errorf("pool of one: %q %v", c.CellsPool(), err)
	}
	many := strings.TrimSpace(strings.Repeat("c ", MaxPool+1))
	for text, want := range map[string]string{
		"cells_accounts =\n":                        "cells_accounts = : expected 1 to 64 account names separated by spaces",
		"cells_accounts = a b,c\n":                  "cells_accounts = a b,c: b,c is not an account name",
		"cells_accounts = a -u\n":                   "cells_accounts = a -u: -u is not an account name",
		"cells_accounts = a ALL\n":                  "cells_accounts = a ALL: ALL is not an account name",
		"cells_accounts = a b a\n":                  "cells_accounts = a b a: a is named twice",
		"cells_accounts = " + many + "\n":           "expected 1 to 64 account names",
		"cells_account = a\ncells_accounts = b c\n": "cells_account and cells_accounts don't go together",
		"cells_accounts = b c\ncells_account = a":   "cells_account and cells_accounts don't go together",
	} {
		_, err := read(t, text)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %s", text, err, want)
		}
	}
}

func TestCellsRunner(t *testing.T) {
	c, err := read(t, "")
	if err != nil || c.CellsRunner != "local" || c.JobServiceAccount != "" || c.JobImage != "" {
		t.Errorf("defaults: %+v %v", c, err)
	}
	c, err = read(t, "cells_runner = kubernetes-job\njob_service_account = md-runbook-cells\njob_image = ghcr.io/smojon/md-runbook-ops:0.29.0\n")
	if err != nil || c.CellsRunner != "kubernetes-job" || c.JobServiceAccount != "md-runbook-cells" || c.JobImage != "ghcr.io/smojon/md-runbook-ops:0.29.0" || c.JobAuditWho {
		t.Errorf("read: %+v %v", c, err)
	}
	c, err = read(t, "job_audit_who = yes\n")
	if err != nil || !c.JobAuditWho {
		t.Errorf("job_audit_who = yes: %+v %v", c, err)
	}
	c, err = read(t, "job_audit_who = no\n")
	if err != nil || c.JobAuditWho {
		t.Errorf("job_audit_who = no: %+v %v", c, err)
	}
	for text, want := range map[string]string{
		"cells_runner = kubernetes\n":      "cells_runner = kubernetes: expected local or kubernetes-job",
		"cells_runner =\n":                 "cells_runner = : expected local or kubernetes-job",
		"job_service_account =\n":          "job_service_account = : expected a Kubernetes service account name",
		"job_service_account = Cells\n":    "job_service_account = Cells: expected a Kubernetes service account name",
		"job_service_account = a b\n":      "job_service_account = a b: expected a Kubernetes service account name",
		"job_service_account = -cells\n":   "job_service_account = -cells: expected a Kubernetes service account name",
		"job_service_account = a..b\n":     "job_service_account = a..b: expected a Kubernetes service account name",
		"job_image =\n":                    "job_image = : expected an image reference (leave the line out for the gate's own pod's image)",
		"job_audit_who = true\n":           "job_audit_who = true: expected yes or no",
		"job_audit_who =\n":                "job_audit_who = : expected yes or no",
		"job_image = x:1 $(id)\n":          "job_image = x:1 $(id): expected an image reference (leave the line out for the gate's own pod's image)",
		"job_image = -x\n":                 "job_image = -x: expected an image reference (leave the line out for the gate's own pod's image)",
		"job_image = \"md-runbook-ops\"\n": "job_image = \"md-runbook-ops\": expected an image reference (leave the line out for the gate's own pod's image)",
	} {
		if _, err := read(t, text); err == nil || err.Error() != want {
			t.Errorf("%q: %v, want %s", text, err, want)
		}
	}
	for s, ok := range map[string]bool{"md-runbook-ops@sha256:" + strings.Repeat("a", 64): true, "localhost:5000/ops:ci": true, "ops": true, "ops ci": false, "": false} {
		if ValidImage(s) != ok {
			t.Errorf("ValidImage(%q) != %v", s, ok)
		}
	}
}

func TestAbsoluteList(t *testing.T) {
	for s, ok := range map[string]bool{
		"/usr/bin:/bin": true, "/x": true, "": false, "/usr/bin::/bin": false, "bin:/usr/bin": false, "/usr/bin:": false, ":/bin": false,
	} {
		if AbsoluteList(s) != ok {
			t.Errorf("AbsoluteList(%q) != %v", s, ok)
		}
	}
}

func TestValidLocale(t *testing.T) {
	for s, ok := range map[string]bool{"C": true, "C.UTF-8": true, "de_DE.utf8@euro": true, "de DE": false, "": false, "a;b": false} {
		if ValidLocale(s) != ok {
			t.Errorf("ValidLocale(%q) != %v", s, ok)
		}
	}
}

func TestValidReportTo(t *testing.T) {
	for s, ok := range map[string]bool{
		"https://runbooks.example.net/v1/runs":      true,
		"https://runbooks.example.net:8443/v1/runs": true,
		"https://runbooks.example.net":              true,
		"http://127.0.0.1:8080/v1/runs":             true,
		"http://localhost/v1/runs":                  true,
		"http://[::1]:9/x":                          true,
		"http://runbooks.example.net/v1/runs":       false,
		"ftp://reports.example.net/runs":            false,
		"https://user@runbooks.example.net/v1/runs": false,
		"https://runbooks.example.net/v1/runs?x=1":  false,
		"https://runbooks.example.net/v1/runs#x":    false,
		"https://runbooks.example.net:123456/":      false,
		"https://runbooks.example.net/a\nhttps://b": false,
	} {
		if ValidReportTo(s) != ok {
			t.Errorf("ValidReportTo(%q) != %v", s, ok)
		}
	}
}

func TestUnsignedOf(t *testing.T) {
	for text, want := range map[string]string{
		"":                                      "refuse",
		"unsigned = allow\n":                    "allow",
		"unsigned = allow\nunsigned = refuse\n": "refuse",
		"un signed\t= allow # trial\r\n":        "allow",
		"unsigned =\n":                          "refuse",
		"unsigned = allow\r\r\n":                "allow\r",
		"# unsigned = allow\n":                  "refuse",
		"unsigned = maybe":                      "maybe",
	} {
		if got := UnsignedOf(strings.NewReader(text)); got != want {
			t.Errorf("UnsignedOf(%q) = %q, want %q", text, got, want)
		}
	}
}
