# Checking runbooks before they run

Some mistakes only show when a runbook runs: a misspelled option is ignored, a `${out:POD}`
has nothing to read. md-runbook checks for them while you edit, and `md-runbook lint` checks
files on the command line, for example on every pull request.

Section 17 of [`examples/sample.runbook.md`](../../examples/sample.runbook.md) has a misspelled
option on purpose, to show a marker.

| Problem | Severity |
|---|---|
| An invalid cell option value (`timeout=abc`, `os=dos`, `expect=/(/`) | error |
| `${out:NAME}` with no earlier block that has `capture=NAME` | error |
| A name used as two kinds of placeholder (`${input:X}` and `${param:X}`) | error |
| An unknown cell option (`retires=3`): it is ignored. A likely typo gets a suggestion (`did you mean "retry"?`): one or two letters off, or the plural of an option (`retries`) | warning |
| `every=` without `retry=` | warning |
| `${param:NAME}` not declared under `params:` in the front matter (no default; the command line needs `--param`) | warning |
| A front matter `mode:`, `timeout:` or `cwd:` value that is ignored (`mode: sometimes`) | warning |
| A front matter `shell:` name that is ignored: unknown (`fish`), a path (`/bin/zsh`), or a second one for the same cells | warning |
| A front matter `prose:` value that is ignored (`prose: loud`) | warning |
| Prose that could be shorter: see [Prose](#prose) | info (`prose: strict`: warning) |

## In the editor

Problems are underlined in the runbook view (on the cell that has them; problems with a block's
fence options are marked on the cell's first line) and in the plain Markdown editor, and they are
listed in the **Problems** panel. Turn this off with `"mdRunbook.lint.enabled": false`.

Prose notes show as information: a blue squiggle, under **Infos** in the Problems panel. The
setting `mdRunbook.lint.prose` changes that for you:

| `mdRunbook.lint.prose` | Shows |
|---|---|
| `information` (default) | A blue squiggle, listed in the Problems panel |
| `hint` | Faint dots under the line only |
| `off` | No prose notes in the editor, not even for `prose: strict` (the command line still reports them) |

A runbook with `prose: strict` shows them as warnings, unless the setting is `off`.

A misspelled option with a suggestion has a **Quick Fix**: click the light bulb on the cell, or
press Ctrl+. (Cmd+. on macOS), then choose **Change "retires" to "retry"**. It renames the option
on the block's fence and keeps its value as written. This works in the runbook view and in the
Markdown editor.

Once a runbook has a run recorded ([run history](history.md#run-history)), the runbook view also
gives a hint (information, not a warning) on a code step that never ran in any recorded run and
has no output now: "This step has never run here." The command line and the app don't have it:
the records are kept by VS Code on this machine.

## In the app

The md-runbook app (iPhone, Android, browser) runs the same checks when a runbook opens and after
each change. Each code cell lists its problems under it, with a mark beside the line concerned.
The top of the runbook counts them ("1 error, 2 warnings"): tap the count to list every problem,
front matter included, and tap one to go to its cell. **⋯ More → Go to Next Problem** goes
through them in turn. A misspelled option with a suggestion has a **Change "retires" to "retry"**
button under the problem, which renames the option as the Quick Fix does.

Prose notes are not problems: a muted line under their Markdown cell says how many there are
("2 prose notes"); tap it to list them. They are not counted at the top. With `prose: strict`
they are warnings, counted and listed like the others.

## On the command line

```sh
md-runbook lint runbooks/*.md            # exit 1 if a file has an error
md-runbook lint --strict runbooks/*.md   # also exit 1 on warnings
```

Each problem is printed as `file:line: severity: message`. Prose notes are printed too, as
`info`, and never change the exit code, not even with `--strict` (`prose: strict` makes them
warnings). On GitHub Actions they are also annotations (prose notes as notices), so they show on
the changed lines of a pull request:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx md-runbook lint --strict runbooks/*.md
```

## Prose

Readers scan. md-runbook points at prose that could be shorter and simpler: keep it short,
simple, stupid. It doesn't judge whether a sentence is useful; you do.

| Rule | Limit | Message |
|---|---|---|
| Sentence length | at most 20 words | `27 words, at most 20: "…"` |
| File average | at most 15 words a sentence | `16.2 words a sentence on average, at most 15` (once, at the first prose line) |
| Paragraph or list item | at most 3 sentences and 60 words | `Several ideas (4 sentences, 72 words): make it a list` |
| Throat-clearing opener | `Please note that`, `Note that`, `It is important to`, `It should be noted that`, `As mentioned above` (or `earlier`, `before`) | `Delete the opener "Note that"` |
| Announcing | `This section describes…`, `The following steps show…`, `In this section…` | `Delete this sentence, it only announces: "…"` |
| Padding | `basically`, `simply`, `just`, `actually`, `really`, `very`; `in order to` | `Delete "just"`, `Use "to", not "in order to"` |
| Says the heading again | the first sentence under a heading has 70 % of its words and adds at most 4 | `Says the heading again: cut it, or add what's new` |
| Repeat | the same sentence twice in a file (6 words or more, case and emphasis ignored) | `Already said on line 12: "…"` |

The phrase lists and the limits are in one place: `PROSE_PHRASES` and `PROSE_LIMITS` in
[`packages/core/src/prose.ts`](../../packages/core/src/prose.ts). They are kept small, to avoid
false alarms.

How text is read:

- Prose is the text outside the front matter, code blocks, HTML comments, tables, headings,
  images and HTML lines. md-runbook's own blocks (outputs, signatures, notes) are not prose.
- A paragraph, a list item and a quote are each a unit; a nested item is a unit of its own.
- A code span, a link or a URL counts as one word.
- A sentence ends at `.`, `!` or `?` before a space and a letter or digit; `e.g.`, `i.e.`, `etc.`,
  `vs.` and version numbers (`0.25.1`) don't end one. ` · ` does.

The counting is the same as a sister project's `prose_ratchet.py`, and the baseline file has
its shape, except for fences: md-runbook reads them as CommonMark does (a ```` fence can hold
``` blocks).

Levels, in the front matter:

```yaml
prose: strict   # on (default: info) | strict: warnings, so lint --strict fails on them | off: no prose checks
```

To skip one paragraph or list item, put `<!-- md-runbook:prose-ignore -->` at the end of one of
its lines, or alone on the line before it.

Why these limits:

- Under 20 words a sentence read best, with the least effort (Kadayat and Eika, 2020:
  *Impact of Sentence Length on the Readability of Web for Screen Reader Users*, HCI International
  2020). Plain-language guides ask for an average of 15 to 20 (Martin Cutts, *Oxford Guide to
  Plain English*; the Australian Government's Style Manual: an average of 15, at most 25).
- 79 % of users scan a page; 16 % read word by word (Nielsen Norman Group, *How Users Read on
  the Web*, 1997). Concise text tested 58 % better.
- Readers skip an idea that the first words of a paragraph don't announce: one idea per
  paragraph, more becomes a list (Nielsen Norman Group, *F-Shaped Pattern of Reading on the Web*,
  2006 and 2017).

## A whole repository

Any Markdown file can be checked for prose: `--prose-only` leaves out the runbook checks, so
code examples in a README aren't read as cells.

```sh
md-runbook lint --prose-only README.md docs/*.md
md-runbook lint --prose-show 'docs/*'   # every finding of the files git tracks that match
```

As a ratchet, no Markdown file may get harder to read, and a new one meets the rules:

```sh
md-runbook lint --prose-baseline .github/prose-baseline.json                     # check
md-runbook lint --prose-baseline .github/prose-baseline.json --update-baseline   # record
```

- It reads the `.md` files git tracks (or the files you name), from the repository root.
- The baseline records, per file, the long sentences, the long paragraphs, the average, and the
  phrases and repeats. Only files with a finding are in it; any other file must have none.
- It fails when a number goes up, or the average passes both its record and 15. It lists those
  findings as `file:line: message`.
- `--update-baseline` only ever lowers a number: a file can get better, never worse.
- Leave files out with `--exclude GLOB`, or in `.md-runbook-prose.json` at the root (see
  below). `*` matches across folders.
- On GitHub Actions the summary also goes to the job summary.

`.md-runbook-prose.json` holds a repository's conventions. This one has a sister project's
(generated time lines, callout labels):

```json
{
  "exclude": ["CLAUDE.md", "tests/fixtures/**"],
  "skipLines": ["^\\*⏱"],
  "labels": ["^(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)?\\*\\*[^*]+\\*\\*\\s+·\\s+"]
}
```

| Key | What | Default |
|---|---|---|
| `exclude` | Files left out (globs) | none |
| `skipLines` | Lines that are not prose (regexes), e.g. generated time lines `*⏱ …*` | none |
| `labels` | Dropped at the start of a paragraph or item before counting (regexes): callout labels such as `🔑 **Key point** · ` | an optional emoji, a bold label, then ` · `; `[]` turns it off |

Regexes are JavaScript's, with the `u` flag. `md-runbook lint` reads the file from the folder it
runs in; the editor and the app use the defaults. A GitHub alert's marker line
(`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) is never prose; the quote's
text after it is.

In CI:

```yaml
prose:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22 }
    - name: "Prose: no Markdown file gets harder to read"
      run: npx md-runbook lint --prose-baseline .github/prose-baseline.json
```
