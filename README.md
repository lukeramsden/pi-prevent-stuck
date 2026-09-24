# @lukeramsden/pi-prevent-stuck

A [pi](https://github.com/earendil-works/pi) extension that keeps coding agents out of shell commands that actually hang: full-screen editors, `top`, fuzzy finders, `watch` loops, and interactive git rebase.

## Why

pi runs the bash tool with stdin as `/dev/null` and stdout/stderr as pipes. In that environment most "interactive" programs exit on their own, so blocking them only gets in the agent's way. This extension blocks only what was verified to hang in that exact environment.

## What it blocks

Everything here either opens `/dev/tty` directly or loops until killed:

- Editors: `vi`, `vim`, `nvim`, `nano`, `pico`, `emacs`, `emacsclient`
  - allowed: `--version`, `vim -es`, `nvim --headless`, `emacs --batch`/`--script`, `emacsclient -n`/`-e`
- `top` — allowed in batch modes: `top -l 1` (macOS), `top -b -n 1` (Linux)
- `watch`
- `fzf`, `peco` — allowed: `--version`, `fzf --filter`/`-f`
- `bun repl`, `deno repl`
- `git rebase -i` / `git rebase --interactive` unless `GIT_SEQUENCE_EDITOR` or `git -c sequence.editor=...` is set inline (git falls back to `vi` for the todo list)

## What it deliberately does not block

Verified to exit on their own with stdin `/dev/null` and a non-TTY stdout:

- REPLs: `python`, `node`, `irb`, `sqlite3`, `psql`, `mysql`, `redis-cli`, `php -a` — they read EOF and quit, even with `-i`
- Pagers: `less`, `more`, `man` — behave like `cat` when stdout is not a TTY
- `tmux`, `screen`, `htop`, `sudo` (without `-n`), `docker login` — error out with "not a terminal"
- `ssh`, `sftp` — no PTY is allocated, so no interactive shell starts

## Git hardening

For Git commands that are otherwise allowed, the extension prepends:

```bash
GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat GIT_EDITOR=: EDITOR=: VISUAL=:
```

This disables terminal credential prompts, Git pagers, and editor launches. Interactive rebase is still blocked unless you explicitly provide a non-interactive sequence editor.

## Install

```bash
pi install npm:@lukeramsden/pi-prevent-stuck
```

Or try it for a single run:

```bash
pi -e npm:@lukeramsden/pi-prevent-stuck
```

## Examples

Blocked:

```bash
git rebase -i HEAD~3
vim src/app.ts
top
ls | fzf
watch npm test
bun repl
```

Allowed or rewritten:

```bash
git log -n 20                 # rewritten with GIT_PAGER=cat
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main
python3 --version
node                          # exits immediately on EOF
less huge.log                 # acts like cat
top -l 1
vim -es -c 'wq' file.txt
```

## Verify

```bash
npm run verify
```

## Research notes

- pi spawns the bash tool with `stdio: ["ignore", "pipe", "pipe"]` on Unix (`core/tools/bash.ts`), so stdin is `/dev/null` and stdout is never a TTY.
- The block list was built by running each candidate under `timeout 3 cmd </dev/null 2>&1 | ...` and keeping only the ones that hit the timeout.
- Git documents `--no-pager`, `GIT_PAGER=cat`, `GIT_EDITOR`, `GIT_ASKPASS`, and `GIT_TERMINAL_PROMPT=0` for non-interactive behavior, and `sequence.editor` / `GIT_SEQUENCE_EDITOR` for `git rebase -i` todo editing.

## License

MIT
