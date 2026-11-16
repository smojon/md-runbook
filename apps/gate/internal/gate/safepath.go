//go:build unix

package gate

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// ---- safe paths (OpenSSH's StrictModes) ----
// A file the gate trusts is only as safe as every folder above it: whoever can write a folder
// can rename what is in it and put something else there. So each folder from the file up to /
// must have an owner the rule allows, and must not be writable by those it guards against. A
// sticky folder they can write (/tmp) is fine when the entry below it has an allowed owner: then
// they can't rename or replace that entry.
//
// Links are followed as the kernel follows them: the path as written is walked (a link's own
// folder must be safe, or the link can be replaced), and so is every link's target, among the
// folders or at the end (review of 0.28.0: resolving links first let a link in an open folder
// pass).

// pathInfo is what the rule needs of a file or folder.
type pathInfo struct {
	uid, gid int
	perm     os.FileMode // the permission bits
	sticky   bool
	link     string // a symbolic link's target, "" for anything else
}

// statFunc stats a path without following a link.
type statFunc func(path string) (pathInfo, error)

// lstat is the real statFunc.
func lstat(p string) (pathInfo, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return pathInfo{}, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return pathInfo{}, errors.New("no owner")
	}
	i := pathInfo{uid: int(st.Uid), gid: int(st.Gid), perm: fi.Mode().Perm(), sticky: fi.Mode()&os.ModeSticky != 0}
	if fi.Mode()&os.ModeSymlink != 0 {
		if i.link, err = os.Readlink(p); err != nil || i.link == "" {
			return pathInfo{}, errors.New("unreadable link")
		}
	}
	return i, nil
}

// pathRule: the owners the folders may have, who must not be able to write them, and whether the
// file itself is held to the same rule.
type pathRule struct {
	owners   map[int]bool
	ownersIs string // "root (or support)": the owners, for messages
	writable func(pathInfo) bool
	who      string // "mdrb-cells": those it guards against, for messages
	file     bool
}

// cellsRule: separated mode's rule for the gate's files. Folders are root's or the gate
// account's, and the cells' account can't write them: as their owner, through one of its groups,
// or as anyone.
func cellsRule(gateUID, cellsUID int, cellsGroups map[int]bool, gateAccount, cells string) pathRule {
	return pathRule{
		owners:   map[int]bool{0: true, gateUID: true},
		ownersIs: "root (or " + gateAccount + ")",
		writable: func(i pathInfo) bool {
			return i.perm&0o002 != 0 || (cellsGroups[i.gid] && i.perm&0o020 != 0) || (i.uid == cellsUID && i.perm&0o200 != 0)
		},
		who: cells,
	}
}

// rootRule: the rule for the programs the gate runs (helpers.go): the file and every folder above
// it root's, and writable by root alone.
func rootRule() pathRule {
	return pathRule{
		owners:   map[int]bool{0: true},
		ownersIs: "root",
		writable: func(i pathInfo) bool { return i.perm&0o022 != 0 },
		who:      "anyone but root",
		file:     true,
	}
}

// linkTarget: where a link at path `at` points.
func linkTarget(at, link string) string {
	if filepath.IsAbs(link) {
		return filepath.Clean(link)
	}
	return filepath.Join(filepath.Dir(at), link)
}

// safePathProblem: "" when p is safe under the rule, else why not (naming the folder). A p that
// doesn't exist yet is checked as where it would be.
func safePathProblem(p string, st statFunc, r pathRule) string {
	if !strings.HasPrefix(p, "/") {
		a, err := filepath.Abs(p)
		if err != nil {
			return "can't check " + p
		}
		p = a
	}
	todo := []string{filepath.Clean(p)}
	seen := map[string]bool{}
	for n := 0; len(todo) > 0; n++ {
		if n >= 40 {
			return "too many links in " + p
		}
		q := todo[0]
		todo = todo[1:]
		if seen[q] {
			continue
		}
		seen[q] = true
		if fi, err := st(q); err == nil {
			switch {
			case fi.link != "":
				todo = append(todo, linkTarget(q, fi.link))
			case r.file && !r.owners[fi.uid]:
				return q + " is owned by uid " + strconv.Itoa(fi.uid) + ": make " + r.ownersIs + " its owner"
			case r.file && r.writable(fi):
				return q + " is writable by " + r.who + ": make it writable by " + r.ownersIs + " alone"
			}
		}
		child, d := q, filepath.Dir(q)
		for {
			di, err := st(d)
			if err != nil {
				if d == filepath.Dir(q) {
					return "the folder of " + q + " doesn't exist"
				}
				return "can't check " + d + ", a folder above " + q
			}
			if di.link != "" {
				// Its own permissions mean nothing; what it points to is walked too, with the rest
				// of the path below it. (Its folder is checked as the walk goes on.)
				todo = append(todo, filepath.Join(linkTarget(d, di.link), strings.TrimPrefix(q, d)))
			} else {
				if !r.owners[di.uid] {
					return d + ", a folder above " + q + ", is owned by uid " + strconv.Itoa(di.uid) + ": make " + r.ownersIs + " its owner"
				}
				if r.writable(di) {
					if !di.sticky {
						return d + ", a folder above " + q + ", is writable by " + r.who + ": make it writable by " + r.ownersIs + " alone"
					}
					ci, err := st(child)
					if err != nil {
						return child + " doesn't exist in " + d + ", which " + r.who + " can write: create it as " + r.ownersIs
					}
					if !r.owners[ci.uid] {
						return child + " is owned by uid " + strconv.Itoa(ci.uid) + " in " + d + ", which " + r.who + " can write: make " + r.ownersIs + " its owner"
					}
				}
			}
			if d == "/" {
				break
			}
			child, d = d, filepath.Dir(d)
		}
	}
	return ""
}
