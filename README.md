# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ahmadmukafi/hidden-spec-cli-01-run-20261122-r1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ahmadmukafi/hidden-spec-cli-01-run-20261122-r1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON. mend reads all four to one written
specification (`SPEC.md` in the kit), finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

Old lines are found at the first of three tiers at which they occur: tier 0 (exact),
tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs
ignored, with re-indentation of the new lines). A context line is written as the file's
own matched line, never the patch's.

## Exit codes

- `0`: the tree is written; one line per changed path, then `ok: <n> files`.
- `1`: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`;
  no file is written.
- `2`: one line for a usage, no-patch, format or parse error; nothing is written.

## Requirements

Node 22 and its standard library alone. No dependencies, no install step.

## License

MIT — see `LICENSE`.
