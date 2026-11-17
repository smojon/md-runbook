//go:build unix

package gate

import (
	"os"
	"reflect"
	"testing"
)

// The cells' mode's look at its home at the lease: an open home of its own closed (a setuid file
// left there is then out of other accounts' reach: review of 0.30.0, H1), one it can't close
// reported. The key files sshd would take are removed (M2; re-check M1: a block can leave one),
// in a closed .ssh or home of its own too; one it can't remove is listed.
func TestCheckHome(t *testing.T) {
	uid := os.Getuid()
	home := t.TempDir()
	os.Chmod(home, 0o755)
	if open, removed, logins := checkHome(home, uid); open || removed != nil || logins != nil {
		t.Errorf("own open home: %v %q %q", open, removed, logins)
	}
	if st, err := os.Stat(home); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("own open home: not closed (%v %v)", st.Mode().Perm(), err)
	}
	// Not the account's (another uid), open, and writable by it: it stays open.
	os.Chmod(home, 0o775)
	if open, _, _ := checkHome(home, uid+1); !open {
		t.Error("another's open home, writable: not reported")
	}
	if st, _ := os.Stat(home); st.Mode().Perm() != 0o775 {
		t.Errorf("another's home changed: %v", st.Mode().Perm())
	}
	os.Chmod(home, 0o700)
	keys, keys2 := home+"/.ssh/authorized_keys", home+"/.ssh/authorized_keys2"
	gone := func(what string) {
		t.Helper()
		for _, p := range []string{keys, keys2} {
			if _, err := os.Lstat(p); err == nil {
				t.Errorf("%s: %s still there", what, p)
			}
		}
	}
	// Either of sshd's default names, a link too (not what it names).
	os.Mkdir(home+"/.ssh", 0o700)
	if _, removed, logins := checkHome(home, uid); removed != nil || logins != nil {
		t.Errorf("an empty .ssh: %q %q", removed, logins)
	}
	os.WriteFile(keys2, []byte("ssh-ed25519 AAAA x\n"), 0o600)
	if _, removed, logins := checkHome(home, uid); !reflect.DeepEqual(removed, []string{keys2}) || logins != nil {
		t.Errorf("authorized_keys2: %q %q", removed, logins)
	}
	gone("authorized_keys2")
	target := home + "/target"
	os.WriteFile(target, nil, 0o600)
	os.Symlink(target, keys)
	os.WriteFile(keys2, nil, 0o600)
	if _, removed, logins := checkHome(home, uid); !reflect.DeepEqual(removed, []string{keys, keys2}) || logins != nil {
		t.Errorf("a link and a file: %q %q", removed, logins)
	}
	gone("a link")
	if _, err := os.Stat(target); err != nil {
		t.Errorf("the link's target went too: %v", err)
	}
	// A folder by that name, with something in it.
	os.MkdirAll(keys+"/x", 0o700)
	if _, removed, logins := checkHome(home, uid); !reflect.DeepEqual(removed, []string{keys}) || logins != nil {
		t.Errorf("a folder: %q %q", removed, logins)
	}
	gone("a folder")
	// A .ssh closed to the account (chmod 000 ~/.ssh): opened to it, then the file goes.
	os.WriteFile(keys, nil, 0o600)
	os.Chmod(home+"/.ssh", 0)
	if _, removed, logins := checkHome(home, uid); !reflect.DeepEqual(removed, []string{keys}) || logins != nil {
		t.Errorf(".ssh closed to the account: %q %q", removed, logins)
	}
	os.Chmod(home+"/.ssh", 0o700)
	gone(".ssh closed")
	// A closed home of its own: the same. Nothing there: nothing removed.
	os.WriteFile(keys2, nil, 0o600)
	os.Chmod(home, 0)
	if _, removed, logins := checkHome(home, uid); !reflect.DeepEqual(removed, []string{keys2}) || logins != nil {
		t.Errorf("home closed to the account: %q %q", removed, logins)
	}
	if st, _ := os.Stat(home); st.Mode().Perm() != 0o700 {
		t.Errorf("closed home: %v", st.Mode().Perm())
	}
	gone("home closed")
	// .ssh not its own (another uid), closed to it: not opened; the file can't go, and is listed.
	// (Only as an account without root's powers: root reads and removes anyway.)
	if os.Geteuid() != 0 {
		os.WriteFile(keys, nil, 0o600)
		os.Chmod(home+"/.ssh", 0o500)
		if _, removed, logins := checkHome(home, uid+1); removed != nil || !reflect.DeepEqual(logins, []string{keys}) {
			t.Errorf("another's .ssh it can't change: %q %q", removed, logins)
		}
		if st, _ := os.Stat(home + "/.ssh"); st.Mode().Perm() != 0o500 {
			t.Errorf("another's .ssh changed: %v", st.Mode().Perm())
		}
		os.Chmod(home+"/.ssh", 0o700)
	}
	// .ssh a file: no key file under it.
	os.RemoveAll(home + "/.ssh")
	os.WriteFile(home+"/.ssh", nil, 0o600)
	if _, removed, logins := checkHome(home, uid); removed != nil || logins != nil {
		t.Errorf(".ssh a file: %q %q", removed, logins)
	}
	// No home: nothing to look at.
	if open, removed, logins := checkHome("", uid); open || removed != nil || logins != nil {
		t.Error("no home")
	}
	if open, removed, logins := checkHome(home+"/none", uid); open || removed != nil || logins != nil {
		t.Error("a home that doesn't exist")
	}
}

// A stop request's cells account: the pid file's second line, one of the pool. Without it (a
// gate before 0.30.0 wrote the file, during the update), the pool's only account (review of
// 0.30.0, L4).
func TestStopAccount(t *testing.T) {
	pool := []string{"mdrb-cells-1", "mdrb-cells-2"}
	for _, c := range []struct {
		rest string
		pool []string
		want string
		ok   bool
	}{
		{"mdrb-cells-2\n", pool, "mdrb-cells-2", true},
		{"mdrb-cells-3\n", pool, "mdrb-cells-3", false},
		{"", pool, "", false},
		{"", []string{"mdrb-cells"}, "mdrb-cells", true},
		{"mdrb-other\n", []string{"mdrb-cells"}, "mdrb-other", false},
	} {
		if got, ok := stopAccount(c.rest, c.pool); got != c.want || ok != c.ok {
			t.Errorf("%q in %q: %q %v", c.rest, c.pool, got, ok)
		}
	}
}
