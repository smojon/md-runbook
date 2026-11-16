//go:build unix

package gate

import (
	"os"
	"strconv"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/procs"
)

// ---- the programs the gate runs (review of 0.28.0, H1) ----
// The gate runs ssh-keygen, id, locale, getent, sh, ps, sudo, systemd-run and bwrap. It takes them
// only from root's system folders, once at its start, and runs them by that path. Never from the
// PATH sshd gave, from path = (the blocks') or from /usr/local: a folder an account can write
// would let it plant ssh-keygen (and pass any signature) or sudo.
//
// Each one found, and every folder above it, must be root's and writable by root alone
// (rootRule): else the gate doesn't start, in any mode. A program it doesn't find is "": the
// gate does without it (getent on macOS) or refuses what needs it (no ssh-keygen: no load).

// sysPath: the folders the gate takes its programs from, in this order. Also the PATH of the
// programs it starts.
const sysPath = "/usr/bin:/bin:/usr/sbin:/sbin"

// helperNames: the programs the gate runs.
var helperNames = []string{"sh", "id", "locale", "getent", "ssh-keygen", "ps", "sudo", "systemd-run", "bwrap"}

// findHelpers: where each program is in sysPath ("" when nowhere).
func findHelpers(find func(path, name string) string) map[string]string {
	h := map[string]string{}
	for _, n := range helperNames {
		h[n] = find(sysPath, n)
	}
	return h
}

// helperProblems: why each program found can't be trusted (rootRule), in helperNames' order.
// outsider: the uid that files of accounts outside this user namespace show (-1: none).
func helperProblems(h map[string]string, st statFunc, outsider int) []string {
	r := rootRule()
	if outsider >= 0 {
		// In a user namespace that doesn't map root (a rootless container, the tests' unshare -r),
		// root's files show as the overflow uid. No account in the namespace can change them.
		r.owners[outsider] = true
	}
	var out []string
	for _, n := range helperNames {
		if p := h[n]; p != "" {
			if why := safePathProblem(p, st, r); why != "" {
				out = append(out, n+" ("+p+"): "+why)
			}
		}
	}
	return out
}

// outsiderUID: the overflow uid when this gate runs in a user namespace that doesn't map root,
// else -1.
func outsiderUID() int {
	if !procs.HaveProc() || procs.RealRoot() {
		return -1
	}
	if m, err := os.ReadFile("/proc/self/uid_map"); err != nil || len(strings.TrimSpace(string(m))) == 0 {
		return -1
	}
	b, err := os.ReadFile("/proc/sys/kernel/overflowuid")
	if err != nil {
		return 65534
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 65534
	}
	return n
}

// loadHelpers finds the programs and checks them; a problem stops the gate.
func (g *Gate) loadHelpers() {
	g.helpers = findHelpers(inPath)
	if probs := helperProblems(g.helpers, lstat, outsiderUID()); len(probs) > 0 {
		g.fatal("the gate runs its programs only from /usr/bin, /bin, /usr/sbin and /sbin, as root's files in folders only root can write:\n  " + strings.Join(probs, "\n  "))
	}
	if ps := g.helpers["ps"]; ps != "" {
		procs.PS = ps
	}
}

// helper: the path of a program the gate runs ("" when this server has none).
func (g *Gate) helper(name string) string { return g.helpers[name] }
