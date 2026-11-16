// Package procs lists processes (Linux: /proc; elsewhere: ps) and decides which of them the
// leftover sweep ends. The decisions are plain functions of a listing, so tests can give one.
package procs

import (
	"strings"
)

// Proc is a process as the sweep sees it.
type Proc struct {
	PID, PPID, UID, PGID, SID int
	Zombie                    bool
	Comm                      string
}

// Children is each process's children, in the listing's order (by pid).
func Children(list []Proc) map[int][]int {
	m := map[int][]int{}
	for _, p := range list {
		m[p.PPID] = append(m[p.PPID], p.PID)
	}
	return m
}

// Descendants is every process under pid, parents first (what a stop request signals).
func Descendants(list []Proc, pid int) []int {
	ch := Children(list)
	var out []int
	seen := map[int]bool{pid: true}
	var walk func(int)
	walk = func(p int) {
		for _, c := range ch[p] {
			if c <= 0 || seen[c] {
				continue
			}
			seen[c] = true
			out = append(out, c)
			walk(c)
		}
	}
	walk(pid)
	return out
}

// SessionRoot is the session's topmost process of the account (below PID 1), found while the gate
// still hangs under sshd: sshd's own process when sshd runs as the account (the ops image). 0
// when the gate's parent changed (or was PID 1 from the start): found after the client went and
// sshd's process for the session ended, the gate's parent would be PID 1, the session the gate
// alone, and sshd a leftover (it was killed, and the ops image's container ended with it).
func SessionRoot(list []Proc, me, ppid0, uid int) int {
	byPID := map[int]Proc{}
	for _, p := range list {
		byPID[p.PID] = p
	}
	self, ok := byPID[me]
	if !ok || self.PPID != ppid0 || ppid0 == 1 {
		return 0
	}
	t := me
	for {
		p, ok := byPID[t]
		if !ok || p.PPID <= 1 {
			break
		}
		parent, ok := byPID[p.PPID]
		if !ok || parent.UID != uid {
			break
		}
		t = p.PPID
	}
	return t
}

// Leftover is a process the sweep may end. Group: when every process of its group is a leftover
// too, the whole group can be stopped at once.
type Leftover struct {
	PID, PPID, PGID int
	Group           bool
}

// InUserManager: the process is in the init.scope of user@UID.service (its /proc/PID/cgroup).
type InUserManager func(pid int) bool

// Leftovers is each process of the account that belongs to no live session. Spared:
//   - this session: everything under its topmost process (top; the gate itself when 0 or gone),
//     and under the gate (me);
//   - every other SSH login: anything under sshd's own process of another account (root's), the
//     leader of its session. Not under any other account's process: a cron job goes, and so does
//     an orphan a subreaper of root adopted (security review round 5);
//   - PID 1, what came in from outside the PID namespace (docker exec, kubectl exec: parent 0),
//     and the account's user manager (systemd --user and its sd-pam: by name, parent and cgroup,
//     as their exe can't be read).
func Leftovers(list []Proc, me, top, uid int, inUM InUserManager) []Leftover {
	byPID := map[int]Proc{}
	for _, p := range list {
		byPID[p.PID] = p
	}
	userman := func(pid int) bool {
		p, ok := byPID[pid]
		return ok && p.Comm == "systemd" && p.PPID == 1 && inUM(pid)
	}
	t := me
	if _, ok := byPID[top]; ok && top > 0 {
		t = top
	}
	cand := map[int]bool{}
	for _, p := range list {
		if p.UID != uid || p.PID <= 1 || p.Zombie {
			continue
		}
		if userman(p.PID) || (p.Comm == "(sd-pam)" && userman(p.PPID) && inUM(p.PID)) {
			continue
		}
		q := p.PID
		spared := false
		for q > 1 {
			qp, ok := byPID[q]
			if !ok {
				break
			}
			if q == t || q == me || qp.PPID == 0 {
				spared = true
				break
			}
			if qp.UID != uid {
				// Another account: an SSH login only under sshd (the leader of its session).
				if qp.SID == q && (qp.Comm == "sshd" || qp.Comm == "sshd-session") {
					spared = true
				}
				break
			}
			q = qp.PPID
		}
		if !spared {
			cand[p.PID] = true
		}
	}
	// A group with anything else in it (of any account) is stopped process by process.
	bad := map[int]bool{}
	for _, p := range list {
		if !p.Zombie && !cand[p.PID] {
			bad[p.PGID] = true
		}
	}
	var out []Leftover
	for _, p := range list {
		if cand[p.PID] {
			out = append(out, Leftover{PID: p.PID, PPID: p.PPID, PGID: p.PGID, Group: p.PGID > 1 && !bad[p.PGID]})
		}
	}
	return out
}

// ParsePS reads `ps -A -o pid= -o ppid=` (where there is no /proc).
func ParsePS(out string) []Proc {
	var list []Proc
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		if len(f) < 2 {
			continue
		}
		pid, ok1 := num(f[0])
		ppid, ok2 := num(f[1])
		if ok1 && ok2 {
			list = append(list, Proc{PID: pid, PPID: ppid})
		}
	}
	return list
}

func num(s string) (int, bool) {
	if s == "" || len(s) > 10 {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int(s[i]-'0')
	}
	return n, true
}

// ParseStat reads /proc/PID/stat: "pid (comm) state ppid pgrp session ...".
func ParseStat(stat string) (p Proc, ok bool) {
	open := strings.IndexByte(stat, '(')
	shut := strings.LastIndexByte(stat, ')')
	if open < 0 || shut < open {
		return p, false
	}
	pid, ok := num(strings.TrimSpace(stat[:open]))
	if !ok {
		return p, false
	}
	p.PID = pid
	p.Comm = stat[open+1 : shut]
	f := strings.Fields(stat[shut+1:])
	if len(f) < 4 {
		return p, false
	}
	p.Zombie = f[0] == "Z"
	var ok1, ok2, ok3 bool
	p.PPID, ok1 = num(f[1])
	p.PGID, ok2 = num(f[2])
	p.SID, ok3 = num(f[3])
	return p, ok1 && ok2 && ok3
}

// ParseUID reads the effective uid from /proc/PID/status (as `ps -o uid=` shows it).
func ParseUID(status string) (int, bool) {
	for _, l := range strings.Split(status, "\n") {
		if strings.HasPrefix(l, "Uid:") {
			f := strings.Fields(l[4:])
			if len(f) >= 2 {
				return num(f[1])
			}
		}
	}
	return 0, false
}
