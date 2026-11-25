//go:build unix

// Package logx writes the gate's events: one JSON line each, to syslog (tag md-runbook-gate,
// facility user, priority notice, as logger(1) sent them) or appended to a file. A failure to log
// never stops a request.
package logx

import (
	"log/syslog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Tag is the syslog tag (journalctl -t md-runbook-gate).
const Tag = "md-runbook-gate"

// Logger writes events with the session's account, key (who) and client address.
type Logger struct {
	// Dest is "syslog" or a file.
	Dest                 string
	Account, Who, Client string
	// CA: the fingerprint of the CA that signed the login's SSH certificate, "" for a plain key.
	// On every line as cert_ca: who is that CA's word (several CAs could name the same person).
	CA string

	mu sync.Mutex
	sl *syslog.Writer
}

// Now is the time as the gate logs it (UTC, seconds).
func Now() string { return time.Now().UTC().Format("2006-01-02T15:04:05Z") }

// Line is an event as one JSON line: time, account, who, client, cert_ca (for a certificate
// login), then the pairs (KEY, VALUE, ...).
func (l *Logger) Line(kv ...string) string {
	var b strings.Builder
	b.WriteString(`{"time":"` + Now() + `"`)
	b.WriteString(`,"account":` + textutil.JSON(l.Account))
	b.WriteString(`,"who":` + textutil.JSON(l.Who))
	b.WriteString(`,"client":` + textutil.JSON(l.Client))
	if l.CA != "" {
		b.WriteString(`,"cert_ca":` + textutil.JSON(l.CA))
	}
	for i := 0; i+1 < len(kv); i += 2 {
		b.WriteString(`,"` + kv[i] + `":` + textutil.JSON(kv[i+1]))
	}
	b.WriteString("}")
	return b.String()
}

// MaxSyslog is the longest event sent to syslog. One datagram can't hold any size (a parameter
// value can be megabytes): a longer event is sent with each value cut to MaxValue bytes, so it
// stays one valid JSON line instead of being lost.
const (
	MaxSyslog = 8192
	MaxValue  = 1024
)

// Event logs one event.
func (l *Logger) Event(kv ...string) {
	line := l.Line(kv...)
	if l.Dest == "syslog" && len(line) > MaxSyslog {
		cut := append([]string(nil), kv...)
		for i := 1; i < len(cut); i += 2 {
			cut[i] = textutil.Cut(cut[i], MaxValue)
		}
		line = l.Line(cut...)
	}
	l.Write(line)
}

// Write logs a line as it is.
func (l *Logger) Write(entry string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Dest == "syslog" {
		if l.sl == nil {
			w, err := syslog.New(syslog.LOG_USER|syslog.LOG_NOTICE, Tag)
			if err != nil {
				return
			}
			l.sl = w
		}
		if l.sl.Notice(entry) != nil {
			// Reconnects on the next event.
			l.sl.Close()
			l.sl = nil
		}
		return
	}
	f, err := os.OpenFile(l.Dest, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o666)
	if err != nil {
		return
	}
	f.WriteString(entry + "\n")
	f.Close()
}
