//go:build linux

package gate

import "syscall"

// prSetNoNewPrivs: PR_SET_NO_NEW_PRIVS (linux/prctl.h).
const prSetNoNewPrivs = 38

// setNoNewPrivs: nothing this thread execs can gain privileges (setuid and setgid bits, file
// capabilities), nor anything it starts. The flag belongs to the thread: the caller locks it
// (runtime.LockOSThread) and execs from it.
func setNoNewPrivs() error {
	if _, _, e := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); e != 0 {
		return e
	}
	return nil
}
