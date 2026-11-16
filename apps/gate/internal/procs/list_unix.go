//go:build unix

package procs

import (
	"errors"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// HaveProc: /proc is there (Linux).
func HaveProc() bool {
	_, err := os.Stat("/proc/self/stat")
	return err == nil
}

// List lists the processes: from /proc, else from `ps` (macOS: pid and parent only).
func List() ([]Proc, error) {
	if !HaveProc() {
		out, err := exec.Command("ps", "-A", "-o", "pid=", "-o", "ppid=").Output()
		if err != nil {
			return nil, err
		}
		return ParsePS(string(out)), nil
	}
	d, err := os.Open("/proc")
	if err != nil {
		return nil, err
	}
	names, err := d.Readdirnames(-1)
	d.Close()
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, n := range names {
		if pid, ok := num(n); ok && pid > 0 {
			pids = append(pids, pid)
		}
	}
	sort.Ints(pids)
	var list []Proc
	for _, pid := range pids {
		dir := "/proc/" + strconv.Itoa(pid)
		stat, err := os.ReadFile(dir + "/stat")
		if err != nil {
			continue // gone meanwhile
		}
		p, ok := ParseStat(string(stat))
		if !ok {
			continue
		}
		status, err := os.ReadFile(dir + "/status")
		if err != nil {
			continue
		}
		if p.UID, ok = ParseUID(string(status)); !ok {
			continue
		}
		list = append(list, p)
	}
	if len(list) == 0 {
		return nil, errors.New("no processes listed")
	}
	return list, nil
}

// Exe is the program a process runs (/proc/PID/exe), "" when it can't be read.
func Exe(pid int) string {
	x, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if err != nil {
		return ""
	}
	return x
}

// CleanEnviron: nothing in the process's environment that loads code (LD_*, BASH_ENV, ENV,
// BASH_FUNC_*). An environment that can't be read counts as clean, as in the shell gate.
func CleanEnviron(pid int) bool {
	env, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return true
	}
	for _, e := range strings.Split(string(env), "\x00") {
		if strings.HasPrefix(e, "LD_") || strings.HasPrefix(e, "BASH_ENV=") || strings.HasPrefix(e, "ENV=") || strings.HasPrefix(e, "BASH_FUNC_") {
			return false
		}
	}
	return true
}

// InUserManagerScope: /proc/PID/cgroup names the init.scope of user@UID.service.
func InUserManagerScope(uid int) InUserManager {
	want := "/user@" + strconv.Itoa(uid) + ".service/init.scope"
	return func(pid int) bool {
		cg, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
		return err == nil && strings.Contains(string(cg), want)
	}
}

// RealRoot: uid 0 is the real root (the uid map maps 0 to 0), not root in a user
// namespace (as in the tests).
func RealRoot() bool {
	m, err := os.ReadFile("/proc/self/uid_map")
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(m), "\n") {
		f := strings.Fields(l)
		if len(f) >= 2 && f[0] == "0" && f[1] == "0" {
			return true
		}
	}
	return false
}
