//go:build unix

package gate

import (
	"os"
	"os/exec"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/config"
	"github.com/smojon/md-runbook/apps/gate/internal/keys"
)

// checkAccount: all signed or none, and what runs before the gate.
//
// The gate's word ("signed, verified") means nothing if another key of the account runs a shell,
// or allows unsigned blocks: those can change what signed blocks find. So each session reads the
// key lines sshd reads for this account and accepts one of two kinds (security review,
// 2026-11-16):
//
//	signed          every line runs this gate, none allows unsigned blocks: run reports go out;
//	unsigned trial  every line allows unsigned blocks: blocks run, run reports don't go out.
//
// Anything else (a line without the gate, a mix, a file it can't read) stops here. What it can't
// see: AuthorizedKeysCommand, certificates' principals, passwords, other programs of the account.
func (g *Gate) checkAccount() {
	home := os.Getenv("HOME")
	files, bad, ok := keys.ExpandFiles(g.cfg.AuthorizedKeys, home, g.account, itoa(g.uid))
	if !ok {
		g.fatal("authorized_keys = " + g.cfg.AuthorizedKeys + ": unknown token %" + bad + " (sshd expands %h, %u, %U and %%)")
	}
	g.keys = files
	keysList := strings.Join(files, " ")

	kind := g.cfg.Unsigned
	if !g.cfg.SSHDForceCommand {
		kind = g.keyLines(files, keysList)
	}
	// (With sshd_force_command, sshd runs this gate for every login of the account, whatever the
	// key lines say: gate.conf's unsigned decides.)

	// ---- what runs before the gate ----
	// sshd starts the forced command with the account's login shell (`SHELL -c COMMAND`), and
	// before that ~/.ssh/rc unless the key line or sshd_config turns it off. Debian's bash reads
	// ~/.bashrc for `bash -c` under sshd, zsh ~/.zshenv: a file the account can write would run
	// before every gate session (security review round 3). Only shells known to read nothing for
	// `-c`: any other (bash, zsh, fish, csh, ...) is refused (security review round 4).
	underSSHD := os.Getenv("SSH_CLIENT")+os.Getenv("SSH_CONNECTION") != ""
	if g.cfg.LoginShellCheck == "yes" && underSSHD {
		shell := passwdField(g.account, 7)
		if shell == "" {
			shell = os.Getenv("SHELL")
		}
		base := shell[strings.LastIndexByte(shell, '/')+1:]
		switch base {
		case "sh", "dash", "ash", "busybox", "ksh", "ksh93", "mksh", "lksh", "oksh", "posh":
		default:
			shown := shell
			if shown == "" {
				shown = "unknown"
			}
			g.accountFatal("this account's login shell is " + shown + ": it can run files of the account before the gate (bash's ~/.bashrc, zsh's ~/.zshenv). Make it /bin/sh: usermod -s /bin/sh " + g.account)
		}
	}
	// sshd reads ~/.ssh/environment before the gate when sshd_config has PermitUserEnvironment
	// yes: LD_PRELOAD there runs code in the gate's programs (security review round 4). Refused
	// either way. (Under sshd also the account's own home: environment= could have moved HOME.)
	homes := []string{home}
	if underSSHD {
		homes = append(homes, passwdField(g.account, 6))
	}
	for _, h := range homes {
		if h == "" {
			continue
		}
		if f := h + "/.ssh/environment"; exists(f) || isLink(f) {
			g.accountFatal(f + " can set the gate's environment: remove it, and keep PermitUserEnvironment no in sshd_config")
		}
	}
	// With ForceCommand the key lines may lack restrict: sshd_config must say PermitUserRC no,
	// and the gate refuses while there is a ~/.ssh/rc that sshd may have run.
	if rc := home + "/.ssh/rc"; g.cfg.SSHDForceCommand && (exists(rc) || isLink(rc)) {
		g.accountFatal(rc + " runs before the gate: remove it, and set PermitUserRC no in sshd_config")
	}
	// This login's own options must be the account's kind: else its key is not where the gate
	// looked.
	if g.cfg.Unsigned != kind {
		g.accountFatal("this login has unsigned = " + g.cfg.Unsigned + ", but the account's keys say " + kind + ": is its key in " + keysList + "?")
	}
	if kind == "allow" && g.reportOn {
		// An unsigned trial: no report from this account may count as sent by a gate.
		g.reportOn = false
		g.reportProblem = "this account allows unsigned blocks: no run reports are sent"
	}
}

// keyLines checks every key line of the account; the account's kind (allow or refuse).
func (g *Gate) keyLines(files []string, keysList string) string {
	var problems strings.Builder
	var allowIDs, refuseIDs []string
	nlines := 0
	env := keys.Env{
		Self: g.self,
		Phys: phys,
		LookPath: func(name string) (string, bool) {
			p, err := exec.LookPath(name)
			return p, err == nil
		},
		Exists:    exists,
		Readable:  readable,
		CanChange: g.canChange,
		UnsignedOf: func(path string) (string, bool) {
			f, err := os.Open(path)
			if err != nil {
				return "", false
			}
			defer f.Close()
			return config.UnsignedOf(f), true
		},
	}
	for _, f := range files {
		// A file that doesn't exist lets no key in.
		if !exists(f) && !isLink(f) {
			continue
		}
		if !readable(f) {
			g.accountFatal("can't read " + f + " (authorized_keys in " + g.configPath + "): the gate checks every key of this account")
		}
		fh, err := os.Open(f)
		if err != nil {
			g.accountFatal("can't read " + f + " (authorized_keys in " + g.configPath + ")")
		}
		lines, err := keys.Parse(fh)
		fh.Close()
		if err != nil {
			g.accountFatal("can't read " + f + " (authorized_keys in " + g.configPath + ")")
		}
		for _, l := range lines {
			nlines++
			ln := itoa(l.N)
			id := ln
			if len(files) > 1 {
				id = f + ":" + ln
			}
			where := "\n  " + f + " line " + ln + ": "
			if l.Kind == keys.KindCmd {
				// Without restrict, forwarding runs code without a signature: -L to docker.sock,
				// say (security review round 3).
				if strings.HasPrefix(l.Open, "restrict") {
					problems.WriteString(where + "add restrict, (else port forwarding and the like stay open)")
				}
				switch rest := strings.TrimPrefix(l.Open, "restrict"); rest {
				case "", ",":
				default:
					problems.WriteString(where + "remove " + strings.TrimPrefix(rest, ",") + " (it turns on again what restrict turns off)")
				}
				// With PermitUserEnvironment, LD_PRELOAD or BASH_ENV there runs code before the
				// gate (security review round 4).
				if l.Env {
					problems.WriteString(where + "remove environment= (it can load code into the gate and its programs)")
				}
			}
			switch l.Kind {
			case keys.KindCmd:
				switch r, u, c := keys.Check(l.Cmd, env); r {
				case keys.OK:
					if u == "allow" {
						allowIDs = append(allowIDs, id)
					} else {
						refuseIDs = append(refuseIDs, id)
					}
				case keys.ConfigChangeable:
					problems.WriteString(where + "its config " + c + " is a file this account can change: make it and its folder root-owned and not writable by the account")
				case keys.WithShell:
					problems.WriteString(where + "command=\"" + l.Cmd + "\" runs the gate with a shell, which can't run it: name the gate alone (" + g.self + ")")
				default:
					problems.WriteString(where + "command=\"" + l.Cmd + "\" must be this gate (" + g.self + ") with only its own options")
				}
			case keys.KindNoCmd:
				problems.WriteString(where + "no command=\"" + g.self + " ...\": every key of this account must run the gate")
			default:
				problems.WriteString(where + "can't read its options (an open quote, or two command= options)")
			}
		}
	}
	if problems.Len() > 0 {
		g.accountFatal("this account's keys don't all run md-runbook-gate:" + problems.String() + "\n  Give other keys their own account.")
	}
	if nlines == 0 {
		g.accountFatal("no key lines in " + keysList + ": set authorized_keys in " + g.configPath + " to the files sshd reads (AuthorizedKeysFile)")
	}
	if len(allowIDs) > 0 && len(refuseIDs) > 0 {
		a := "line " + allowIDs[0] + " allows"
		if len(allowIDs) > 1 {
			a = "lines " + strings.Join(allowIDs, " ") + " allow"
		}
		r := "line " + refuseIDs[0]
		if len(refuseIDs) > 1 {
			r = "lines " + strings.Join(refuseIDs, " ")
		}
		g.accountFatal(a + " unsigned blocks and " + r + " don't: an account is all signed or all unsigned. Give the unsigned keys their own account.")
	}
	if len(allowIDs) > 0 {
		return "allow"
	}
	return "refuse"
}

// passwdField: field n (1-based) of the account's passwd entry (getent, so NSS accounts too);
// "" without getent (macOS) or an entry.
func passwdField(account string, n int) string {
	if _, err := exec.LookPath("getent"); err != nil {
		return ""
	}
	out, err := exec.Command("getent", "passwd", account).Output()
	if err != nil {
		return ""
	}
	first, _, _ := strings.Cut(string(out), "\n")
	f := strings.Split(first, ":")
	if n-1 < len(f) {
		return f[n-1]
	}
	return ""
}
