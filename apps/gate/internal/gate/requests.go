//go:build unix

package gate

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/ere"
	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
	"github.com/smojon/md-runbook/apps/gate/internal/names"
	"github.com/smojon/md-runbook/apps/gate/internal/proto"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
	"github.com/smojon/md-runbook/apps/gate/internal/sshsig"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

func (g *Gate) clearParams() {
	g.pnames = nil
	g.params = map[string]string{}
}

func (g *Gate) addExported(n string) {
	for _, e := range g.exported {
		if e == n {
			return
		}
	}
	g.exported = append(g.exported, n)
}

func (g *Gate) hasParam(n string) bool {
	_, ok := g.params[n]
	return ok
}

// decodeValue: a base64 value as the shell gate's $(… | base64 -d) gave it: NULs dropped (a
// shell variable can't hold one), trailing newlines too. Not base64: empty.
func decodeValue(b64 string) string {
	b, ok := proto.Decode(b64)
	if !ok {
		return ""
	}
	return strings.TrimRight(strings.ReplaceAll(string(b), "\x00", ""), "\n")
}

// doLoad: load ID MANIFEST SIGNATURE [SIGNATURE ...]: up to 5 signatures of the one manifest
// (author, reviewer, ...); the server's `signers` says how many distinct trusted signers it needs.
func (g *Gate) doLoad(rid string, args []string) {
	// A `called` or `note` request is for this load only, whether it succeeds or not.
	cb, cc := g.calledBy, g.calledCall
	g.calledBy, g.calledCall = "", ""
	note := g.note
	g.note = proto.Note{}
	ok := len(args) >= 2 && len(args) <= 6
	for _, a := range args {
		if !textutil.IsB64(a) {
			ok = false
		}
	}
	if !ok {
		g.refuse(rid, "bad load request")
		return
	}
	g.loaded = false
	g.clearParams()
	// The previous runbook's parameters and env.* values don't carry over to this one.
	if len(g.exported) > 0 {
		g.send("unset " + strings.Join(g.exported, " ") + "\n")
		g.exported = nil
	}
	// Kept in memory: what was verified is what runs.
	raw, ok := proto.Decode(args[0])
	if !ok {
		g.refuse(rid, "the manifest is not base64")
		return
	}
	m := manifest.Parse(string(raw))
	if !m.HasHeader() {
		g.refuse(rid, "not an md-runbook manifest, or a newer version than this gate reads")
		return
	}
	if !readable(g.cfg.AllowedSigners) {
		g.refuse(rid, "this server trusts no signers yet ("+g.cfg.AllowedSigners+")")
		return
	}
	// Each signature that verifies counts once per principal (two signatures of one key are one
	// signer); a signature from a key this server doesn't trust counts for nothing.
	keygen := g.helper("ssh-keygen")
	if keygen == "" {
		g.refuse(rid, "this server has no ssh-keygen in "+sysPath+" (OpenSSH 8.2 or newer)")
		return
	}
	v := sshsig.Verifier{Keygen: keygen, AllowedSigners: g.cfg.AllowedSigners, Dir: g.work}
	var principals []string
	for _, sig := range args[1:] {
		p := v.Principal(raw, sig)
		if p == "" {
			continue
		}
		seen := false
		for _, q := range principals {
			if q == p {
				seen = true
			}
		}
		if !seen {
			principals = append(principals, p)
		}
	}
	if len(principals) == 0 {
		g.refuse(rid, "the signature is not from a trusted signer (or the runbook was changed after signing)")
		return
	}
	principal := strings.Join(principals, ",")
	mhash := sha256Hex(raw)
	mname := m.Field("name", "", 2)
	mversion := m.Field("version", "", 2)
	// As core's parseManifest reads it: name, version, expires and scope once each (this reads
	// the first one, core refuses a second), the version a whole number (a word made the floors
	// check below fail open) and expires a date (security review, 2026-11-16).
	if dup := m.Duplicate(); dup != "" {
		g.refuse(rid, "the manifest has more than one "+dup+" line")
		return
	}
	if !textutil.IsNum(mversion) || mversion == "0" {
		g.refuse(rid, "the manifest's version is not a whole number")
		return
	}
	expires := m.Field("expires", "", 2)
	if expires != "" && !manifest.IsDate(expires) {
		g.refuse(rid, "the manifest's expires is not a date (YYYY-MM-DD)")
		return
	}
	if len(principals) < atoi(g.cfg.Signers) {
		g.refuse(rid, mname+" version "+mversion+" needs "+g.cfg.Signers+" signers here; signed by "+principal)
		return
	}
	if g.cfg.Revoked != "" {
		data, err := os.ReadFile(g.cfg.Revoked)
		if err != nil || !readable(g.cfg.Revoked) {
			g.refuse(rid, "can't read the revoked list "+g.cfg.Revoked)
			return
		}
		if revoked(string(data), mhash) {
			g.refuse(rid, mname+" version "+mversion+" was withdrawn (revoked)")
			return
		}
	}
	// Version floors: `NAME LOWEST` per line; versions of that runbook below LOWEST are withdrawn.
	if g.cfg.Floors != "" {
		data, err := os.ReadFile(g.cfg.Floors)
		if err != nil || !readable(g.cfg.Floors) {
			g.refuse(rid, "can't read the floors list "+g.cfg.Floors)
			return
		}
		floor := floorOf(string(data), mname)
		// A floor too big to compare must not make the check fail open: refuse instead.
		if floor != "" && !textutil.IsNum(floor) {
			g.refuse(rid, "the floors list has a bad version for "+mname+" ("+floor+")")
			return
		}
		if floor != "" && atoi(mversion) < atoi(floor) {
			g.refuse(rid, mname+" version "+mversion+" is older than the lowest version this server runs ("+floor+")")
			return
		}
	}
	if expires != "" && time.Now().UTC().Format("2006-01-02") > expires {
		g.refuse(rid, mname+" version "+mversion+" expired on "+expires)
		return
	}
	mscopes := m.Scopes()
	ok = false
	if mscopes == "" {
		ok = g.cfg.Scopes == "*" && (g.keyScopes == "" || g.keyScopes == "*")
	} else {
		for _, s := range textutil.Fields(mscopes) {
			if hasScope(g.cfg.Scopes, s) && (g.keyScopes == "" || hasScope(g.keyScopes, s)) {
				ok = true
			}
		}
	}
	if !ok {
		is, accepts := mscopes, g.keyScopes
		if is == "" {
			is = "no scope"
		}
		if accepts == "" {
			accepts = g.cfg.Scopes
		}
		g.refuse(rid, mname+" is for "+is+"; this server or key accepts "+accepts)
		return
	}
	for _, n := range m.Names() {
		if !textutil.IsVar(n) || names.IsReserved(n) {
			g.refuse(rid, mname+" sets "+n+", a name the gate doesn't let a runbook set")
			return
		}
	}
	// The rest as core's parseManifest reads it, or not at all: the first-item reads the runs make
	// then agree with every client's (apps/gate/testdata/vectors.json). Last, so the refusals
	// above keep their own words.
	if err := manifest.Check(string(raw)); err != nil {
		g.refuse(rid, "the manifest can't be read as clients read it ("+err.Error()+")")
		return
	}
	g.man, g.principal, g.mhash, g.mname, g.mversion = m, principal, mhash, mname, mversion
	// This runbook's own shell (the same one loaded again, or after a call, keeps it).
	g.shellFor(mhash)
	g.loaded = true
	g.stepCell = ""
	// For the run report: what this manifest is, kept by its hash for the end of the session.
	// Its signers stay in memory: the first load's, as the manifest's copy.
	if g.reportOn {
		if _, ok := g.rbManifest[mhash]; !ok {
			g.rbManifest[mhash] = m
		}
	}
	if _, ok := g.rbSigner[mhash]; !ok {
		g.rbSigner[mhash] = principal
	}
	// The load event, with what a `called` or `note` request said about it.
	kv := []string{"event", "load", "id", rid, "runbook", mname, "version", mversion, "hash", mhash, "signer", principal}
	if cb != "" {
		kv = append(kv, "called-by", cb, "call", cc)
	}
	if note.Alert != "" {
		kv = append(kv, "alert", note.Alert)
	}
	if note.Fingerprint != "" {
		kv = append(kv, "alert-fingerprint", note.Fingerprint)
	}
	if note.StartsAt != "" {
		kv = append(kv, "alert-starts-at", note.StartsAt)
	}
	g.log.Event(kv...)
	os.Stdout.WriteString("\x1e__MDRB_SIGNED__ " + principal + " " + mhash + "\n")
	marker(rid, "0")
}

// revoked: the hash is in the revoked list. One hash per line, as md-runbook verify prints it;
// tolerant of CRLF, blanks, upper case and a sha256: prefix.
func revoked(list, hash string) bool {
	for _, l := range strings.Split(list, "\n") {
		l = strings.NewReplacer("\r", "", " ", "", "\t", "").Replace(l)
		l = strings.Map(func(r rune) rune {
			if r >= 'A' && r <= 'F' {
				return r + 32
			}
			return r
		}, l)
		l = strings.TrimPrefix(l, "sha256:")
		if l == hash {
			return true
		}
	}
	return false
}

// floorOf: the lowest version of the runbook in the floors list, "" for none.
func floorOf(list, name string) string {
	for _, l := range strings.Split(strings.ReplaceAll(list, "\r", ""), "\n") {
		if i := strings.IndexByte(l, '#'); i >= 0 {
			l = l[:i]
		}
		f := textutil.Fields(l)
		if len(f) >= 2 && textutil.AwkEqual(f[0], name) && strings.Trim(f[1], "0123456789") == "" {
			return f[1]
		}
	}
	return ""
}

// hasScope: a scope list (space-separated, or *) contains s.
func hasScope(list, s string) bool {
	if list == "*" {
		return true
	}
	for _, w := range textutil.Fields(list) {
		if w == s {
			return true
		}
	}
	return false
}

// doCalled: called ID HASH N: the next load is called by call N of the runbook whose manifest
// has sha256 HASH.
func (g *Gate) doCalled(rid string, args []string) {
	if len(args) == 2 && textutil.IsHex64(args[0]) && textutil.IsNum(args[1]) {
		g.calledBy, g.calledCall = args[0], args[1]
		marker(rid, "0")
		return
	}
	g.refuse(rid, "bad called request")
}

// doNote: note ID KEY VALUE ...: (protocol 3) the next load answers this alert, as the client
// says (proto.ParseNote).
func (g *Gate) doNote(rid string, args []string) {
	n, ok := proto.ParseNote(args)
	if !ok {
		g.refuse(rid, "bad note request")
		return
	}
	g.note = n
	marker(rid, "0")
}

func (g *Gate) doParam(rid string, args []string) {
	// An empty value is an empty base64 field.
	if len(args) == 1 {
		args = append(args, "")
	}
	if len(args) != 2 || !textutil.IsVar(args[0]) || !textutil.IsB64(args[1]) {
		g.refuse(rid, "bad param request")
		return
	}
	name := args[0]
	if !g.loaded {
		g.refuse(rid, "no signed runbook loaded")
		return
	}
	pat64 := g.man.Param(name)
	if pat64 == "" {
		g.refuse(rid, g.mname+" has no parameter "+name)
		return
	}
	patBytes, _ := proto.Decode(pat64)
	pat := strings.TrimRight(string(patBytes), "\n")
	raw, ok := proto.Decode(args[1])
	if !ok {
		g.refuse(rid, "bad value for "+name)
		return
	}
	value := string(raw)
	// One line, matching the whole pattern (POSIX ERE, as grep -E read it). (A NUL can't be in a
	// shell variable: such a value is refused. A CR neither, as clients refuse it: core's
	// isOneLineValue.)
	if !textutil.IsOneLine(value) || !ere.MatchWhole(pat, value) {
		g.refuse(rid, "the value of "+name+" doesn't match its pattern "+pat)
		return
	}
	if !g.hasParam(name) {
		g.pnames = append(g.pnames, name)
	}
	g.params[name] = value
	g.log.Event("event", "param", "id", rid, "runbook", g.mname, "name", name, "value", value)
	marker(rid, "0")
}

// doRun: a whole signed cell (k ""), or its k-th command.
func (g *Gate) doRun(rid, cell, k string) {
	if !g.loaded {
		g.refuse(rid, "no signed runbook loaded")
		return
	}
	m := g.man
	mode := m.Field("cell", cell, 3)
	if mode == "" {
		g.refuse(rid, g.mname+" has no signed cell "+cell)
		return
	}
	for _, p := range m.All("needs", cell, 2) {
		if !g.hasParam(p) {
			g.refuse(rid, g.mname+" needs a value for the parameter "+p)
			return
		}
	}
	// kube-context= in the signed info string: the gate checks it itself, in the shell, with the
	// cell's env.* (a client could skip the `context` request; security review, 2026-11-16).
	info, ok := proto.Decode(m.Field("info", cell, 2))
	if !ok {
		g.refuse(rid, "bad cell in the manifest")
		return
	}
	kube, hasKube := manifest.KubeWant(string(info))
	if hasKube {
		if strings.HasPrefix(kube, "${param:") && strings.HasSuffix(kube, "}") && len(kube) >= len("${param:}") {
			kp := kube[len("${param:") : len(kube)-1]
			if !textutil.IsVar(kp) {
				g.refuse(rid, "cell "+cell+" has a kube-context the gate can't read: "+kube)
				return
			}
			if !g.hasParam(kp) {
				g.refuse(rid, g.mname+" needs a value for the parameter "+kp+" (its kube-context)")
				return
			}
			kube = g.params[kp]
		}
		if !kubeName.MatchWhole(kube) {
			g.refuse(rid, "cell "+cell+"'s kube-context is not a Kubernetes context name: "+kube)
			return
		}
	}
	var code64 string
	if k == "" {
		code64 = m.Field("code", cell, 2)
		g.stepCell = ""
	} else {
		// Commands run in order (Step through, Run lines 1-N) unless the cell is signed with
		// lines=any.
		if mode != "any" && k != "0" && !(g.stepCell == cell && k == g.stepNext) {
			g.refuse(rid, "cell "+cell+" runs whole or its lines in order; single lines need lines=any in the signed runbook")
			return
		}
		code64 = m.Step(cell, atoi(k))
		if code64 == "" {
			g.refuse(rid, "cell "+cell+" has no command "+k)
			return
		}
		g.stepCell = cell
		g.stepNext = itoa(atoi(k) + 1)
	}
	code, ok := proto.Decode(code64)
	if !ok {
		g.refuse(rid, "bad cell in the manifest")
		return
	}
	// Unsigned text ran in this runbook's shell since its load: a fresh one, as a load would give
	// (security review round 4).
	if g.slots[g.cur].dirty {
		g.shellFor(g.mhash)
	}
	g.runs++
	g.log.Event("event", "run", "id", rid, "runbook", g.mname, "version", g.mversion, "hash", g.mhash, "signer", g.principal, "cell", cell, "step", k)
	nonce := ""
	if g.reportOn || g.separated() {
		var b [8]byte
		rand.Read(b[:])
		nonce = hex.EncodeToString(b[:])
	}
	if g.separated() {
		g.exitsMu.Lock()
		g.sepRuns[itoa(g.runs)] = sepRun{rid: rid, nonce: nonce}
		g.exitsMu.Unlock()
	}
	if g.reportOn {
		step := k
		if step == "" {
			step = "-"
		}
		g.reportRuns = append(g.reportRuns, report.Run{N: itoa(g.runs), Hash: g.mhash, Cell: cell, Step: step, Start: logx.Now(), Nonce: nonce})
	}
	g.emitRun(rid, cell, string(code), nonce, kube, hasKube)
}

// A Kubernetes context name.
var kubeName = func() *ere.Pattern {
	p, err := ere.Compile(`[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,252}`)
	if err != nil {
		panic(err)
	}
	return p
}()

// What the shell runs after the block, at the end of each run: the end event and the markers.
const endMarkers = `printf '\036%s %s\n' "__MDRB_${__mdrb_id}__" "$__mdrb_rc" >&2; printf '\036%s %s\n' "__MDRB_${__mdrb_id}__" "$__mdrb_rc"` + "\n"

// emitRun writes the commands that run the code in the shell, with the cell's cwd= and
// environment. The code goes through the shell's pipe itself, single-quoted, and runs as the body
// of a function (`return` ends the block, as `.` did). Never a file: a file can be swapped between
// a hash check and the read (a FIFO serves the check one text and the shell another; security
// review round 3). nonce: of this run's line in report-exits.
func (g *Gate) emitRun(rid, cell, code, nonce, kube string, hasKube bool) {
	g.showPID()
	m := g.man
	var b strings.Builder
	for _, n := range g.pnames {
		if !textutil.IsVar(n) || names.IsReserved(n) {
			continue
		}
		b.WriteString("export " + n + "=" + textutil.SQ(g.params[n]) + "\n")
		g.addExported(n)
	}
	for _, e := range m.Env(cell) {
		if !textutil.IsVar(e.Name) || names.IsReserved(e.Name) {
			continue
		}
		b.WriteString("export " + e.Name + "=" + textutil.SQ(decodeValue(e.Value)) + "\n")
		g.addExported(e.Name)
	}
	b.WriteString("__mdrb_id=" + rid + "\n__mdrb_rc=0\n__mdrb_kr=\n")
	// The code, quoted as SQ does, with its last newline (a here-document may end the block).
	b.WriteString("__mdrb_c='" + strings.ReplaceAll(code, "'", `'\''`) + "\n'\n")
	b.WriteString("export MD_RUNBOOK_GATE_RUN=" + rid + "\n")
	cwd64 := m.Field("cwd", cell, 2)
	if cwd64 != "" {
		b.WriteString("__mdrb_dir=" + textutil.SQ(decodeValue(cwd64)) + "\n")
		b.WriteString(`__mdrb_cd=$PWD; __mdrb_in=; if cd -- "$__mdrb_dir"; then __mdrb_in=1; else __mdrb_rc=1; fi` + "\n")
	}
	if hasKube {
		who := `"account":` + textutil.JSON(g.account) + `,"who":` + textutil.JSON(g.who) + `,"client":` + textutil.JSON(g.client)
		b.WriteString("__mdrb_kw=" + textutil.SQ(kube) + "\n__mdrb_who=" + textutil.SQ(who) + "\n")
		// kubectl's current context with the cell's environment (env.KUBECONFIG) and folder; the
		// name as logged keeps only the characters a context name has.
		b.WriteString(`if [ "$__mdrb_rc" = 0 ]; then __mdrb_kc=$(command kubectl config current-context </dev/null 2>/dev/null) || __mdrb_kc=; if [ "$__mdrb_kc" != "$__mdrb_kw" ]; then __mdrb_kc=$(printf '%s' "$__mdrb_kc" | tr -cd 'A-Za-z0-9._:@/+-' | cut -c 1-253); printf '%s\n' "md-runbook-gate: this block is for the Kubernetes context $__mdrb_kw; the current context here is ${__mdrb_kc:-none}: nothing ran" >&2; __mdrb_rc=126; __mdrb_kr="kube-context is ${__mdrb_kc:-none}, not $__mdrb_kw"; fi; fi` + "\n")
		// (Separated mode: the refusal goes to the gate with the run's exit, readExitsFile; the log
		// is out of the cells' reach.)
		if !g.separated() && g.cfg.Log == "syslog" {
			b.WriteString(`[ -n "$__mdrb_kr" ] && logger -t md-runbook-gate -- "{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",$__mdrb_who,\"event\":\"refused\",\"id\":\"$__mdrb_id\",\"reason\":\"$__mdrb_kr\"}" 2>/dev/null` + "\n")
		} else if !g.separated() {
			b.WriteString("__mdrb_log=" + textutil.SQ(g.cfg.Log) + "\n")
			b.WriteString(`[ -n "$__mdrb_kr" ] && printf '%s\n' "{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",$__mdrb_who,\"event\":\"refused\",\"id\":\"$__mdrb_id\",\"reason\":\"$__mdrb_kr\"}" >>"$__mdrb_log" 2>/dev/null` + "\n")
		}
	}
	b.WriteString(`if [ "$__mdrb_rc" = 0 ]; then __mdrb_run() { eval "$__mdrb_c"; }; __mdrb_run </dev/null; __mdrb_rc=$?; fi; unset -f __mdrb_run; unset __mdrb_c` + "\n")
	if cwd64 != "" {
		b.WriteString(`[ -n "$__mdrb_in" ] && cd -- "$__mdrb_cd" 2>/dev/null` + "\n")
	}
	if g.separated() {
		// The run's exit (and a kube-context refusal) to the gate, which logs the end event: the
		// nonce only in what the shell reads after the block.
		b.WriteString("__mdrb_n=" + itoa(g.runs) + "\n__mdrb_rx=" + textutil.SQ(g.exitsPath) + "\n")
		b.WriteString(`printf '%s\t%s\t%s\t%s\t%s\n' "$__mdrb_n" "$__mdrb_rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ` + nonce + ` "$__mdrb_kr" >>"$__mdrb_rx" 2>/dev/null` + "\n")
		b.WriteString(endMarkers)
		g.send(b.String())
		return
	}
	if g.reportOn {
		// The nonce only in what the shell reads after the block.
		b.WriteString("__mdrb_n=" + itoa(g.runs) + "\n__mdrb_rx=" + textutil.SQ(g.work+"/report-exits") + "\n")
		b.WriteString(`printf '%s\t%s\t%s\t%s\n' "$__mdrb_n" "$__mdrb_rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ` + nonce + ` >>"$__mdrb_rx" 2>/dev/null` + "\n")
	}
	if g.cfg.Log == "syslog" {
		b.WriteString(`logger -t md-runbook-gate -- "{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"end\",\"id\":\"$__mdrb_id\",\"exit\":$__mdrb_rc}" 2>/dev/null` + "\n")
	} else {
		b.WriteString("__mdrb_log=" + textutil.SQ(g.cfg.Log) + "\n")
		b.WriteString(`printf '%s\n' "{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"end\",\"id\":\"$__mdrb_id\",\"exit\":$__mdrb_rc}" >>"$__mdrb_log" 2>/dev/null` + "\n")
	}
	b.WriteString(endMarkers)
	g.send(b.String())
}

func (g *Gate) doRaw(rid string, args []string) {
	// An empty cell is an empty base64 field, as clients write it (gateRawCommand; gate vectors).
	if len(args) == 0 {
		args = []string{""}
	}
	if len(args) != 1 || !textutil.IsB64(args[0]) {
		g.refuse(rid, "bad raw request")
		return
	}
	if g.cfg.Unsigned != "allow" {
		g.refuse(rid, "this server runs signed runbooks only (this cell is not signed, or changed since signing)")
		return
	}
	text, ok := proto.Decode(args[0])
	if !ok {
		g.refuse(rid, "bad raw request")
		return
	}
	// Straight to the shell, never to disk: the text exports the cell's secret values.
	g.log.Event("event", "unsigned", "id", rid, "hash", sha256Hex(text))
	// This shell ran unsigned text: no signed runbook gets it again (security review round 3),
	// and the next signed run of the loaded one starts a fresh shell (round 4).
	g.slots[g.cur].dirty = true
	g.showPID()
	// Not a signed run: tools must not log against the last one.
	g.send("unset MD_RUNBOOK_GATE_RUN\n" + string(text))
}

// doContext: `kubectl config current-context` in the shell, for the app's kube-context guard.
// Answered whether or not unsigned cells may run: it only reads the kubeconfig.
func (g *Gate) doContext(rid string, args []string) {
	if len(args) != 0 {
		g.refuse(rid, "bad context request")
		return
	}
	g.log.Event("event", "context", "id", rid)
	g.showPID()
	g.send("__mdrb_id=" + rid + "\nkubectl config current-context </dev/null; __mdrb_rc=$?\n" + endMarkers)
}

// readExits reads the work folder's report-exits.
func (g *Gate) readExits() map[string]report.Exit {
	if g.separated() {
		return g.sepExitsCopy()
	}
	f, err := os.Open(g.work + "/report-exits")
	if err != nil {
		return map[string]report.Exit{}
	}
	defer f.Close()
	return report.ReadExits(bufio.NewReader(f), g.reportRuns)
}
