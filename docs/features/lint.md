# Checking runbooks before they run

Some mistakes only show when a runbook runs: a misspelled option is ignored, a `${out:POD}`
has nothing to read. md-runbook checks for them while you edit. `md-runbook lint` checks files
on the command line, for example on every pull request.

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
| A runbook call with an empty body: a plain Markdown viewer shows an empty box (see below) | info |
| Prose that could be shorter: see [Prose](#prose) | info (`prose: strict`: warning) |

## In the editor

Problems are underlined in the runbook view and in the plain Markdown editor, and listed in the
**Problems** panel. The runbook view marks the cell that has them, or its first line for a block's
fence options. Turn this off with `"mdRunbook.lint.enabled": false`.

Prose notes show as information: a blue squiggle, under **Infos** in the Problems panel. The
setting `mdRunbook.lint.prose` changes that for you:

| `mdRunbook.lint.prose` | Shows |
|---|---|
| `information` (default) | A blue squiggle, listed in the Problems panel |
| `hint` | Faint dots under the line only |
| `off` | No prose notes in the editor, not even for `prose: strict` (the command line still reports them) |

A runbook with `prose: strict` shows them as warnings, unless the setting is `off`.

A misspelled option with a suggestion has a **Quick Fix**, in the runbook view and in the
Markdown editor:

1. Click the light bulb on the cell, or press Ctrl+. (on macOS, Cmd+.).
2. Choose **Change "retires" to "retry"**.

The Quick Fix renames the option on the block's fence and keeps its value as written.

A runbook call with an empty body gets a note: `This call's body is empty: a plain Markdown
viewer shows an empty box. Add a comment saying what it runs.`

- Its Quick Fix **Add a comment naming the runbook** writes the body's first line:
  `# Runs the runbook campaign/2a-restore.runbook.md (section Restore)`.
- The note shows as information, whatever `mdRunbook.lint.prose` says: it is not a prose note.

The runbook view marks a code step that never ran in a recorded run
([run history](history.md#run-history)) and has no output now. The hint is information, not a
warning: `This step has never run here.`

The command line and the app don't have it: the records are kept by VS Code on this machine.

## In the app

The md-runbook app (iPhone, Android, browser) runs the same checks when a runbook opens and after
each change.

- Each code cell lists its problems under it, with a mark beside the line concerned.
- The top of the runbook counts them ("1 error, 2 warnings"). Tap the count to list every
  problem, front matter included; tap one to go to its cell.
- **⋯ More → Go to Next Problem** goes through them in turn.
- A misspelled option with a suggestion has a **Change "retires" to "retry"** button under the
  problem. It renames the option as the Quick Fix does.
- A runbook call with an empty body shows its note under the call, with an **Add a comment
  naming the runbook** button. The note isn't counted at the top.

Prose notes are not problems, and are not counted at the top. A muted line under their Markdown
cell says how many there are ("2 prose notes"); tap it to list them. With `prose: strict` they
are warnings, counted and listed like the others.

## On the command line

```sh
md-runbook lint runbooks/*.md            # exit 1 if a file has an error
md-runbook lint --strict runbooks/*.md   # also exit 1 on warnings
```

Each problem is printed as `file:line: severity: message`. Prose notes are printed too, as
`info`. They never change the exit code, not even with `--strict` (`prose: strict` makes them
warnings).

An empty runbook call is an `info` note too, never failing. It ends with the line to add:
`First line: # Runs the runbook a.md`.

On GitHub Actions problems are also annotations (prose notes as notices), so they show on a pull
request's changed lines:

```yaml
- uses: actions/setup-node@v7
  with: { node-version: 22 }
- run: |
    npm install --no-save --ignore-scripts --no-audit --no-fund --prefix "$RUNNER_TEMP/md-runbook" md-runbook@0.36.0
    "$RUNNER_TEMP/md-runbook/node_modules/.bin/md-runbook" lint --strict runbooks/*.md
```

Pin the version, and install with `--ignore-scripts`: md-runbook needs no install scripts. Code
scanners such as SonarCloud flag `npx` in CI, because it can install a package and run its scripts.

## Prose

Readers scan. md-runbook points at prose that could be shorter and simpler: keep it short,
simple, stupid. It doesn't judge whether a sentence is useful; you do.

| Rule | Limit | Message |
|---|---|---|
| Sentence length | at most 20 words (`prose: strict`: a warning only past 25) | `27 words, at most 20: "…"` |
| Paragraph or list item | at most 3 sentences and 60 words; a box's labelled paragraph 5 and 100 (see [Boxes](#boxes)) | `Several ideas (4 sentences, 72 words): make it a list` |
| Throat-clearing opener | `Please note that`, `Note that`, `It is important to`, `It should be noted that`, `As mentioned above` (or `earlier`, `before`) | `Delete the opener "Note that"` |
| Padding | `basically`, `simply`, `of course`, `obviously`; `in order to` | `Delete "simply"`, `Use "to", not "in order to"` |
| Announcing | `This section describes…`, `The following steps show…`, `In this section…` | `Delete this sentence, it only announces: "…"` |
| Says the heading again | the first sentence under a heading has 70 % of its words and adds at most 4 | `Says the heading again: cut it, or add what's new` |
| Repeat | the same sentence twice in a file (6 words or more, case and emphasis ignored) | `Already said on line 12: "…"` |
| Empty lead-in | a paragraph of at most 6 words, ending in `:`, starting with `Now`, `Then`, `Next`, `First`, `Again`, `Back to`, `Here` or `On the lab`, right before a code block; not one that says `shortened`, `abridged`, `excerpt`, `trimmed`, `the first lines` or `the last lines` | `Empty lead-in: start with what the block does, or cut it` |
| Duration | in a runbook with `estimate=`: a duration of the whole (`This guide takes about 40 minutes`, `about 40 minutes in all`, `About 40 minutes.`), or one with `takes` or `allow` in the first paragraph of the runbook or of a section, but not one right before a block | `Duration in prose: it goes stale; the estimates show it` |
| Choppy | 3 sentences or more in a row under 8 words each, in one paragraph or box | `Choppy: join these sentences with their link word` |
| Leaning bullet | a bullet right after a sibling bullet, starting with `It`, `Its`, `This`, `That`, `These`, `Those`, `They`, `There`, `Then`, `So`, `But` or `And` (not in a numbered list) | `Leans on the item before: join them into a sentence, or make it stand alone` |
| Box in paragraphs | a box with a blank `>` line between two paragraphs (not around a list) | `Box in 2 paragraphs: make it one` |
| Box repeats | a box's first sentence says a sentence of the paragraph right above it again (60 % of its content words, or 4 in a row) | `Box repeats this sentence: cut it here, keep the box` (on that sentence) |
| Box repeats a box | the same, against the box before it in the section | `Says what the box above says: cut one` (on the later box) |
| Quote without a source | a quotation of 6 words or more, with no link in its paragraph, list item or box: see [Quotations](#quotations) | `Quote without a source: link it in the same paragraph` |
| Said in several files | only on the command line, over many files: see [A whole repository](#a-whole-repository) | `Said in 3 files: say it once and link it` |

A file's average (at most 15 words a sentence) is no note any more; the ratchet still records
it. On a sister project it never flagged a file without a long sentence, and it pushed towards
choppy text.

The phrase lists and the limits are in one place: `PROSE_PHRASES` and `PROSE_LIMITS` in
[`packages/core/src/prose.ts`](../../packages/core/src/prose.ts). They are kept small, to avoid
false alarms.

The guard keeps the sentence rules off a sentence that states a fact, a reason, a condition or a
warning:

- a sentence with a digit, a code span or a link;
- or one of these words: `because`, `so that`, `never`, `must`, `only`, `not`, `unless`, `until`, `except`.

The sentence rules are the announcing, heading, repeat, lead-in, duration, choppy and box-repeat
rules; a duration keeps its digit. Openers and padding cut words, not the sentence: they always
apply (`Please note that it never retries` still loses `Please note that`).

How text is read:

- Prose is the text outside the front matter, code blocks, HTML comments, tables, headings,
  images and HTML lines. md-runbook's own blocks (outputs, signatures, notes) are not prose.
- A paragraph, a list item and a quote are each a unit. A nested item is a unit of its own.
- A code span, a link, a URL or a quotation counts as one word.
- A sentence ends at `.`, `!` or `?` before a space and a letter or digit; ` · ` ends one too.
- No sentence ends at `e.g.`, `i.e.`, `etc.`, `vs.` or a version number (`0.25.1`).
- Nor at initials (`L. Peter Deutsch`), `no.` before a number, or a label's `?` in running
  text (`a Did you know? box`).
- Nor in a code span, or at a `?` in emphasis before lowercase (`*Up?* turns red`).
- Links in parentheses alone (`([source](…), [paper](…))`) are a citation, not a sentence.

The counting is the same as a sister project's `prose_ratchet.py`, except for fences, and the
baseline file has its shape. md-runbook reads fences as CommonMark does (a ```` fence can hold
``` blocks).

Levels, in the front matter:

```yaml
prose: strict   # on (default: info) | strict: warnings, so lint --strict fails on them | off: no prose checks
```

Under `prose: strict`, a sentence of 21 to 25 words stays a note; past 25 it is a warning
(`27 words, at most 25: "…"`).

To skip one paragraph or list item, put `<!-- md-runbook:prose-ignore -->` at the end of one of
its lines, or alone on the line before it.

Why these limits:

- Under 20 words a sentence read best, with the least effort. Source: Kadayat and Eika, HCI
  International 2020, *Impact of Sentence Length on the Readability of Web for Screen Reader
  Users*.
- Plain-language guides ask for an average of 15 to 20: Martin Cutts, *Oxford Guide to Plain
  English*. The Australian Government's Style Manual asks for an average of 15, at most 25.
- 79 % of users scan a page; 16 % read word by word. Source: Nielsen Norman Group, *How Users
  Read on the Web*, 1997. Concise text tested 58 % better.
- Readers skip an idea the first words of a paragraph don't announce: one idea per paragraph,
  more becomes a list. Source: Nielsen Norman Group, *F-Shaped Pattern of Reading on the Web*,
  2006 and 2017.

Writing rules, not checked: a person has to judge them.

- Keep the link word (`because`, `so`, `when`, `while`) when you split a sentence. Without it the
  reader loses why one thing follows the other. Don't invent one either: a `so` claims a cause.

### Boxes

A box is a quote whose first paragraph carries a label: `> 💡 **Did you know?** · …`. The label
is an optional emoji, a bold label, then ` · `, ` — `, ` – ` or `:` (`> 🔑 **Key point:** …`).
A configured `labels` entry makes a box too, and so does a GitHub alert (`> [!TIP]`).

That labelled paragraph may have 5 sentences and 100 words. Any other paragraph in the box, and
every paragraph outside one, keeps 3 and 60.

Why: a story box is read through, while steps are scanned. On nevis-rest-api, a blind test ranked
split or 3/60 boxes last in 9 of 10 cases. In that repository 125 of 316 boxes fit 5/100,
against 49 at 3/60.

Set other box limits, or turn boxes off, in `.md-runbook-prose.json`:

```json
{ "boxes": { "sentences": 5, "words": 100 } }
```

With `"boxes": false` a labelled paragraph keeps 3 and 60, and the box hints are off.

### Quotations

A quotation is in `“…”`, `«…»` or `"…"`. A straight `"` opens after a space or a bracket, so
`a 3" pipe` holds none.

- A quotation counts as one word: it never makes a sentence or a paragraph too long.
  - No rule reads its words: a `basically` in it is the source's.
  - The same quote in 3 files is no duplicate.
  - A `.`, `?` or `!` inside it ends no sentence; its own last one does (`He wrote “Stop.” Then…`).
- Quote word for word, from the source you link. Shorten the words around a quote, never the quote.
- A quotation of 6 words or more needs a link in its paragraph, list item or box.
  - Not checked for a source: shorter quotes, and quotes in table cells (tables aren't read).
    Link those yourself.
- Write a program's messages and output as code, between backticks, not in quotation marks. The
  source hint then fires on people's words only.
- A block quote whose last line is its source (a link, or `— Name`) is a quotation as a whole. It
  isn't checked, and needs no other source:

```markdown
> Every step is checked before it runs.
> — The team's runbook policy
```

## A whole repository

Any Markdown file can be checked for prose. `--prose-only` leaves out the runbook checks, so
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
- The baseline records, per file, the long sentences, the long paragraphs, the average, the
  phrases, the repeats and the duplicates. Only files with a finding are in it; any other file
  must have none.
- A long sentence counts here only past 25 words (`strictSentenceWords`), where `prose: strict`
  warns. One of 21 to 25 words stays a hint in the editor and doesn't fail the check.
- The check fails when a number goes up, or the average passes both its record and 15. It lists
  those findings as `file:line: message`.
- `--update-baseline` only ever lowers a number: a file can get better, never worse.
- Leave files out with `--exclude GLOB`, or in `.md-runbook-prose.json` at the root (see
  below). `*` matches across folders.
- On GitHub Actions the summary also goes to the job summary.

Over many files it also finds text said in several places:

- A sentence or paragraph of 8 words or more, in 3 files or more, is noted at each place.
- Text is compared in lower case, without links or digits.
- A sentence of at most 20 words with a link points to where it is said: it is no duplicate.
- Paragraphs that share 60 % of their 5-word runs count as the same. A paragraph said as a whole
  is one note, not one a sentence.
- `--prose-show` compares with every tracked file, as the ratchet does.
- The baseline key is `duplicates`.

`.md-runbook-prose.json` holds a repository's conventions. This one has nevis-rest-api's
(generated time lines, mail subjects, callout labels):

```json
{
  "exclude": ["CLAUDE.md", "tests/fixtures/**"],
  "skipLines": ["^\\*⏱", "^Subject:", "^=== Part \\d+ of \\d+"],
  "labels": ["^(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)?\\*\\*[^*]+\\*\\*\\s+·\\s+"],
  "limits": { "sentenceWords": 20, "strictSentenceWords": 25, "averageWords": 15, "unitSentences": 3, "unitWords": 60 },
  "boxes": { "sentences": 5, "words": 100 }
}
```

| Key | What | Default |
|---|---|---|
| `exclude` | Files left out (globs) | none |
| `skipLines` | Lines that are not prose (regexes), e.g. generated time lines `*⏱ …*` | none |
| `labels` | Dropped at the start of a paragraph or item before counting (regexes): callout labels such as `🔑 **Key point** · ` | an optional emoji, a bold label, then ` · `, ` — `, ` – ` or `:`; `[]` turns it off |
| `limits` | The limits below; any may be left out | the defaults below |
| `boxes` | A box's labelled paragraph: `{"sentences": n, "words": n}`, or `false` for no boxes | 5 sentences, 100 words |

Limits, each a positive whole number (anything else is an error):

| Limit | Default | What |
|---|---|---|
| `sentenceWords` | 20 | Words a sentence, at most |
| `strictSentenceWords` | 25 | With `prose: strict`: past this, a long sentence is a warning |
| `averageWords` | 15 | Words a sentence on average in a file (the ratchet only) |
| `unitSentences` | 3 | Sentences a paragraph or list item, at most |
| `unitWords` | 60 | Words a paragraph or list item, at most |

Regexes are JavaScript's, with the `u` flag. `md-runbook lint` reads the file from the folder it
runs in; the editor and the app use the defaults. A GitHub alert's marker line
(`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) is never prose; the quote's
text after it is.

In CI:

```yaml
prose:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-node@v7
      with: { node-version: 22 }
    - name: "Prose: no Markdown file gets harder to read"
      run: |
        npm install --no-save --ignore-scripts --no-audit --no-fund --prefix "$RUNNER_TEMP/md-runbook" md-runbook@0.36.0
        "$RUNNER_TEMP/md-runbook/node_modules/.bin/md-runbook" lint --prose-baseline .github/prose-baseline.json
```
