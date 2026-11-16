// Package config reads gate.conf: `key = value` lines, # comments, the last line of a key wins.
// Any unknown key, or a bad value, stops the gate (it fails closed).
package config

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Default is /etc/md-runbook/gate.conf.
const Default = "/etc/md-runbook/gate.conf"

// Config is gate.conf with its defaults.
type Config struct {
	Unsigned       string
	Scopes         string
	AllowedSigners string
	Revoked        string
	Floors         string
	Signers        string
	Log            string
	ReportTo       string
	ReportToken    string
	// The cells' PATH: root-owned folders only. Never the account's profile (a file the account
	// can write) and never the client's.
	Path   string
	Locale string
	// The cells' KUBECONFIG (else kubectl's default, ~/.kube/config): never the account's.
	Kubeconfig string
	// no: don't check the account's login shell (tests on a server whose accounts have bash).
	LoginShellCheck string
	// The files sshd reads this account's keys from (AuthorizedKeysFile): %h is the home folder,
	// %u the account, %U its uid, %% a %; a relative path is in the home folder.
	AuthorizedKeys string
	// yes: at the start and end of each session, end the account's processes that belong to no
	// live session (Linux; see the sweep).
	KillLeftovers string
	// Obsolete (the shell gate's: start without setsid or perl). Read, checked and ignored: the
	// gate always gives each shell a process group of its own. Set when the file has it.
	AllowNoGroupKill string
	// The gate's own memory (not the blocks'), in MiB; 0 for none.
	MemoryLimit string
	// yes: sshd_config's ForceCommand runs this gate (with --sshd-force-command).
	SSHDForceCommand bool
	// How each session's cells are kept together, so that they end with it: auto (the best this
	// server has), scope (a systemd scope), bwrap (a PID namespace) or none (process groups, and
	// the kill_leftovers sweep). scope and bwrap are required: without them the gate doesn't start.
	Isolation string
	// The account the cells run as (separated mode, through sudo); "" runs them as the gate's own
	// account (shared mode).
	CellsAccount string
}

// Isolations are the values of isolation =.
var Isolations = []string{"auto", "scope", "bwrap", "none"}

// accountName: an account name as useradd takes it (and macOS's _names).
var accountName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`)

// ValidAccount: a name cells_account = may hold.
func ValidAccount(s string) bool { return accountName.MatchString(s) }

// Defaults are the settings without a gate.conf.
func Defaults() Config {
	return Config{
		Unsigned:        "refuse",
		Scopes:          "*",
		AllowedSigners:  "/etc/md-runbook/allowed_signers",
		Signers:         "1",
		Log:             "syslog",
		Path:            "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		Locale:          "auto",
		LoginShellCheck: "yes",
		AuthorizedKeys:  "%h/.ssh/authorized_keys %h/.ssh/authorized_keys2",
		KillLeftovers:   "no",
		MemoryLimit:     "512",
		Isolation:       "auto",
	}
}

// Read applies the lines of r (the file name for messages) to c.
func (c *Config) Read(r io.Reader, name string) error {
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line == "" && err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("can't read %s", name)
		}
		line = strings.TrimSuffix(line, "\n")
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = textutil.Trim(k)
		v = textutil.Trim(v)
		switch k {
		case "unsigned":
			c.Unsigned = v
		case "scopes":
			c.Scopes = v
		case "allowed_signers":
			c.AllowedSigners = v
		case "revoked":
			c.Revoked = v
		case "floors":
			c.Floors = v
		case "signers":
			c.Signers = v
		case "log":
			c.Log = v
		case "report_to":
			c.ReportTo = v
		case "report_token_file":
			c.ReportToken = v
		case "path":
			c.Path = v
		case "locale":
			c.Locale = v
		case "kubeconfig":
			c.Kubeconfig = v
		case "login_shell_check":
			if v != "yes" && v != "no" {
				return fmt.Errorf("login_shell_check = %s: expected yes or no", v)
			}
			c.LoginShellCheck = v
		case "authorized_keys":
			c.AuthorizedKeys = v
		case "kill_leftovers", "allow_no_group_kill":
			if v != "yes" && v != "no" {
				return fmt.Errorf("%s = %s: expected yes or no", k, v)
			}
			if k == "kill_leftovers" {
				c.KillLeftovers = v
			} else {
				c.AllowNoGroupKill = v
			}
		case "memory_limit":
			if !textutil.IsMiB(v) {
				return fmt.Errorf("memory_limit = %s: expected a number of MiB (0 for none)", v)
			}
			c.MemoryLimit = v
		case "sshd_force_command":
			switch v {
			case "yes":
				c.SSHDForceCommand = true
			case "no":
			default:
				return fmt.Errorf("sshd_force_command = %s: expected yes or no", v)
			}
		case "isolation":
			ok := false
			for _, i := range Isolations {
				ok = ok || v == i
			}
			if !ok {
				return fmt.Errorf("isolation = %s: expected auto, scope, bwrap or none", v)
			}
			c.Isolation = v
		case "cells_account":
			// Empty is not "shared": leave the line out for that (fail closed).
			if !ValidAccount(v) {
				return fmt.Errorf("cells_account = %s: expected an account name (leave the line out to run the cells as the gate's account)", v)
			}
			c.CellsAccount = v
		default:
			return fmt.Errorf("%s: unknown setting %q", name, k)
		}
		if err != nil {
			return nil
		}
	}
}

// ReadFile reads the gate.conf at path.
func (c *Config) ReadFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("can't read %s", path)
	}
	defer f.Close()
	return c.Read(f, path)
}

// AbsoluteList: path = and kubeconfig =: absolute entries separated by :, none empty (an empty
// or relative entry would be the cell's working folder).
func AbsoluteList(s string) bool {
	for _, e := range strings.Split(s, ":") {
		if e == "" || e[0] != '/' {
			return false
		}
	}
	return true
}

// LocaleName: a locale name such as C.UTF-8.
var localeName = regexp.MustCompilePOSIX(`^[A-Za-z0-9._@-]+$`)

// ValidLocale: a name such as C.UTF-8 (auto is resolved before).
func ValidLocale(s string) bool { return localeName.MatchString(s) }

// The address run reports go to: https without a user name or query, http only for localhost.
var reportTo = regexp.MustCompilePOSIX(`^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%+=-]*)?|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/%+=-]*)?)$`)

// ValidReportTo: report_to is an address the gate sends to.
func ValidReportTo(s string) bool { return !strings.ContainsAny(s, "\n") && reportTo.MatchString(s) }

// UnsignedOf is the `unsigned` of a gate.conf as a key line's check reads it (the last one; an
// empty value is refuse). Keys are read without any blank in them, as the shell gate's awk did.
func UnsignedOf(r io.Reader) string {
	u := ""
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line == "" && err != nil {
			break
		}
		line = strings.TrimSuffix(line, "\n")
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSuffix(line, "\r")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.NewReplacer(" ", "", "\t", "").Replace(k)
		if k == "unsigned" {
			u = strings.Trim(v, " \t")
		}
		if err != nil {
			break
		}
	}
	if u == "" {
		return "refuse"
	}
	return u
}
