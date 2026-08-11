# @lukeramsden/pi-prevent-stuck

A [pi](https://github.com/earendil-works/pi) extension that keeps coding agents out of known shell traps: interactive editors, pagers, REPLs, terminal UIs, watch loops, prompt-only logins, and interactive git rebase.

## Why

Agents run shell commands through a non-interactive tool boundary. Commands that wait for a full-screen UI, a pager, an editor, a password/login prompt, a REPL, or an interrupt can hang the run until a timeout.

## What it blocks

Conservative default blocks include:

- Editors: `vi`, `vim`, `nvim`, `nano`, `pico`, `emacs`, `emacsclient`
- Pagers/help browsers: `less`, `more`, `most`, `man`, `info`
- TUIs and interrupt-only loops: `top`, `htop`, `btop`, `watch`, `tmux`, `screen`, `fzf`, `peco`
- REPLs when run without a script/command: `python`, `python3`, `node`, `deno`, `bun`; plus `irb`, `pry`, and `php -a`
- Interactive database/shell clients unless given a command/file/stdin: `psql`, `mysql`, `mariadb`, `sqlite3`, `redis-cli`
- Remote/file-transfer shells: `ssh` without a remote command, `sftp`, `ftp`
- Prompt-only Docker auth: `docker login` unless credentials are provided with `--password-stdin` or `--password`
- `git rebase -i` / `git rebase --interactive` unless `GIT_SEQUENCE_EDITOR` or `git -c sequence.editor=...` is set inline

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
less huge.log
docker login -u luke
ssh prod-box
watch npm test
```

Allowed or rewritten:

```bash
git log -n 20                 # rewritten with GIT_PAGER=cat
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main
docker login --username foo --password-stdin < token.txt
python -c 'print("ok")'
psql -c 'select 1'
ssh prod-box 'uname -a'
```

## Verify

```bash
npm run verify
```

## Research notes

- Git documents `--no-pager`, `GIT_PAGER=cat`, `GIT_EDITOR`, `GIT_ASKPASS`, and `GIT_TERMINAL_PROMPT=0` for non-interactive behavior.
- Git documents `sequence.editor` and `GIT_SEQUENCE_EDITOR` for `git rebase -i` todo editing.
- Docker documents `docker login --password-stdin` as the non-interactive login path.
- CircleCI documents that non-interactive shells can time out on prompts and pagers, and recommends disabling pagination such as with `git --no-pager`.

## License

MIT
