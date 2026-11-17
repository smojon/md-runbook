//go:build unix

package gate

import (
	"os"
	"reflect"
	"testing"
)

// The cells' mode's look at its home at the lease: an open home of its own closed (a setuid file
// left there is then out of other accounts' reach: review of 0.30.0, H1), one it can't close
// reported, and the key files sshd would take listed (M2).
func TestCheckHome(t *testing.T) {
	uid := os.Getuid()
	home := t.TempDir()
	os.Chmod(home, 0o755)
	if open, logins := checkHome(home, uid); open || logins != nil {
		t.Errorf("own open home: %v %q", open, logins)
	}
	if st, err := os.Stat(home); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("own open home: not closed (%v %v)", st.Mode().Perm(), err)
	}
	// Not the account's (another uid), open, and writable by it: it stays open.
	os.Chmod(home, 0o775)
	if open, _ := checkHome(home, uid+1); !open {
		t.Error("another's open home, writable: not reported")
	}
	if st, _ := os.Stat(home); st.Mode().Perm() != 0o775 {
		t.Errorf("another's home changed: %v", st.Mode().Perm())
	}
	os.Chmod(home, 0o700)
	// Key files: either of sshd's default names, one in a folder it can't look into too.
	os.Mkdir(home+"/.ssh", 0o700)
	if _, logins := checkHome(home, uid); logins != nil {
		t.Errorf("an empty .ssh: %q", logins)
	}
	os.WriteFile(home+"/.ssh/authorized_keys2", []byte("ssh-ed25519 AAAA x\n"), 0o600)
	if _, logins := checkHome(home, uid); !reflect.DeepEqual(logins, []string{home + "/.ssh/authorized_keys2"}) {
		t.Errorf("authorized_keys2: %q", logins)
	}
	os.Symlink("/nowhere", home+"/.ssh/authorized_keys")
	if _, logins := checkHome(home, uid); len(logins) != 2 {
		t.Errorf("a link too: %q", logins)
	}
	os.Chmod(home+"/.ssh", 0)
	if _, logins := checkHome(home, uid); len(logins) != 2 {
		t.Errorf(".ssh closed to the account: %q", logins)
	}
	os.Chmod(home+"/.ssh", 0o700)
	// .ssh a file: no key file under it.
	os.RemoveAll(home + "/.ssh")
	os.WriteFile(home+"/.ssh", nil, 0o600)
	if _, logins := checkHome(home, uid); logins != nil {
		t.Errorf(".ssh a file: %q", logins)
	}
	// No home: nothing to look at.
	if open, logins := checkHome("", uid); open || logins != nil {
		t.Error("no home")
	}
	if open, logins := checkHome(home+"/none", uid); open || logins != nil {
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
