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
	// How each session's cells are kept together, so that they end with it: auto (scope where it
	// works, else none; never bwrap), scope (a systemd scope), bwrap (a PID namespace) or none
	// (process groups, and the kill_leftovers sweep). scope and bwrap are required: without them
	// the gate doesn't start.
	Isolation string
	// The account the cells run as (separated mode, through sudo); "" runs them as the gate's own
	// account (shared mode). A pool of one: one session at a time.
	CellsAccount string
	// cells_accounts: a pool of such accounts. Each session leases one that no other session of
	// the gate's account holds (separated mode). Never together with cells_account.
	CellsAccounts []string
	// Where the cells run: local (this host: shared, or separated with cells_account) or
	// kubernetes-job (a Kubernetes Job of their own for each session, in the gate's namespace).
	CellsRunner string
	// kubernetes-job: the cells' service account (required), and the Job's image ("" for the
	// gate's own pod's image).
	JobServiceAccount string
	JobImage          string
}

// Isolations are the values of isolation =.
var Isolations = []string{"auto", "scope", "bwrap", "none"}

// Runners are the values of cells_runner =.
var Runners = []string{"local", "kubernetes-job"}

// A Kubernetes object name (a DNS-1123 subdomain, as service account names are).
var kubeName = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)

// ValidKubeName: a name job_service_account = may hold.
func ValidKubeName(s string) bool { return kubeName.MatchString(s) && !strings.Contains(s, "..") }

// An image reference: registry/name:tag or @sha256:digest, nothing a shell or YAML would read.
var imageRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$`)

// ValidImage: a name job_image = may hold.
func ValidImage(s string) bool { return imageRef.MatchString(s) }

// accountName: an account name as useradd takes it (and macOS's _names).
var accountName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`)

// ValidAccount: a name cells_account = (and each of cells_accounts =) may hold. Never ALL: in
// sudoers that is any account, root included.
func ValidAccount(s string) bool { return accountName.MatchString(s) && s != "ALL" }

// MaxPool: the most accounts cells_accounts = may name.
const MaxPool = 64

// CellsPool: the accounts separated mode leases from, in gate.conf's order (cells_account is a
// pool of one); nil in shared mode.
func (c Config) CellsPool() []string {
	if c.CellsAccount != "" {
		return []string{c.CellsAccount}
	}
	return c.CellsAccounts
}

// CellsKey: the setting that named the pool, for messages.
func (c Config) CellsKey() string {
	if c.CellsAccount != "" {
		return "cells_account"
	}
	return "cells_accounts"
}

// parsePool reads cells_accounts =: account names separated by blanks, each once.
func parsePool(v string) ([]string, error) {
	names := strings.Fields(v)
	if len(names) == 0 || len(names) > MaxPool {
		return nil, fmt.Errorf("cells_accounts = %s: expected 1 to %d account names separated by spaces (leave the line out to run the cells as the gate's account)", v, MaxPool)
	}
	for i, n := range names {
		if !ValidAccount(n) {
			return nil, fmt.Errorf("cells_accounts = %s: %s is not an account name", v, n)
		}
		for _, m := range names[:i] {
			if m == n {
				return nil, fmt.Errorf("cells_accounts = %s: %s is named twice", v, n)
			}
		}
	}
	return names, nil
}

// finish: the checks across settings, once the whole file is read.
func (c *Config) finish() error {
	if c.CellsAccount != "" && len(c.CellsAccounts) > 0 {
		return fmt.Errorf("cells_account and cells_accounts don't go together: keep cells_accounts (a pool of one is cells_accounts = %s)", c.CellsAccount)
	}
	return nil
}

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
		CellsRunner:     "local",
	}
}

// Read applies the lines of r (the file name for messages) to c.
func (c *Config) Read(r io.Reader, name string) error {
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line == "" && err != nil {
			if err == io.EOF {
				return c.finish()
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
		case "cells_accounts":
			pool, err := parsePool(v)
			if err != nil {
				return err
			}
			c.CellsAccounts = pool
		case "cells_runner":
			if v != Runners[0] && v != Runners[1] {
				return fmt.Errorf("cells_runner = %s: expected local or kubernetes-job", v)
			}
			c.CellsRunner = v
		case "job_service_account":
			if !ValidKubeName(v) {
				return fmt.Errorf("job_service_account = %s: expected a Kubernetes service account name", v)
			}
			c.JobServiceAccount = v
		case "job_image":
			// Empty is not "the pod's own image": leave the line out for that (fail closed).
			if !ValidImage(v) {
				return fmt.Errorf("job_image = %s: expected an image reference (leave the line out for the gate's own pod's image)", v)
			}
			c.JobImage = v
		default:
			return fmt.Errorf("%s: unknown setting %q", name, k)
		}
		if err != nil {
			return c.finish()
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
