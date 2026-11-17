//go:build unix && !linux

package gate

// setNoNewPrivs: macOS has no equivalent of Linux's no_new_privs. A pool account's home is closed
// to the others at each lease instead (checkHome); see apps/gate/README.md for /tmp.
func setNoNewPrivs() error { return nil }
