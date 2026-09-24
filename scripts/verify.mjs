import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extensionPath = fileURLToPath(new URL("../extensions/prevent-stuck.ts", import.meta.url));
const mod = await jiti.import(extensionPath);
const factory = mod.default ?? mod;
const { decidePreventStuck } = mod;

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`  ✓ ${name}`);
}

console.log("prevent-stuck extension verification\n");

check("default export is a factory", () => assert.equal(typeof factory, "function"));
check("exports decision helper", () => assert.equal(typeof decidePreventStuck, "function"));

// Verified to hang with stdin=/dev/null and stdout=pipe (how pi runs bash):
// they open /dev/tty directly or loop until killed.
const blocks = [
	"git rebase -i HEAD~3",
	"git rebase --interactive main",
	"echo ok && git -C repo rebase -ir main",
	"vim src/app.ts",
	"nvim src/app.ts",
	"nano notes.txt",
	"emacs file.el",
	"emacsclient file.el",
	"top",
	"sudo top",
	"timeout 5 top",
	"watch npm test",
	"fzf",
	"ls | fzf",
	"peco",
	"bun repl",
	"deno repl",
];

for (const cmd of blocks) {
	check(`blocks ${cmd}`, () => assert.equal(decidePreventStuck(cmd).action, "block"));
}

// Verified to exit on their own in the same environment.
const allowed = [
	"GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main",
	"git -c sequence.editor=true rebase -i main",
	// editors in scripted/version modes
	"vim --version",
	"vim -es -c 'wq' file.txt",
	"nvim --headless -c 'q'",
	"emacs --batch -l build.el",
	"emacsclient -n file.txt",
	"emacsclient -e '(+ 1 2)'",
	// process monitors in batch modes
	"top -l 1",
	"top -b -n 1",
	"top -bn1",
	// fuzzy finders in filter/version modes
	"fzf --version",
	"printf 'a\\nb' | fzf --filter a",
	"printf 'a\\nb' | fzf -f a",
	// REPLs: EOF on stdin makes them exit immediately
	"python",
	"python3",
	"python3 -i",
	"python3 --version && command -v uv || true",
	"python3 -V; command -v cc || true",
	"'/usr/bin/python3' -V",
	"python3 -m venv .venv",
	"python -c 'print(1)'",
	"node",
	"node -i",
	"node --version",
	"node -e 'console.log(1)'",
	"bun",
	"bun --version",
	"deno --version",
	"irb",
	"php -a",
	// pagers behave like cat when stdout is not a TTY
	"less huge.log",
	"more huge.log",
	"man git",
	// database shells exit on EOF
	"psql mydb",
	"mysql -u root",
	"sqlite3 db.sqlite",
	"sqlite3 db.sqlite 'select 1'",
	"redis-cli",
	// multiplexers/TUIs error out without a terminal; detached forms are legit
	"tmux new -d -s work",
	"tmux ls",
	"screen -dmS x true",
	"htop",
	// no PTY is allocated, so no interactive shell
	"ssh prod-box",
	"ssh prod-box 'uname -a'",
	"sftp prod-box",
	// errors out: "cannot perform an interactive login from a non-TTY device"
	"docker login -u luke",
	"docker login --username foo --password-stdin < token.txt",
];

for (const cmd of allowed) {
	check(`allows ${cmd}`, () => assert.notEqual(decidePreventStuck(cmd).action, "block"));
}

check("rewrites ordinary git commands with non-interactive environment", () => {
	const decision = decidePreventStuck("git log -n 3");
	assert.equal(decision.action, "rewrite");
	assert.match(decision.command, /GIT_TERMINAL_PROMPT=0/);
	assert.match(decision.command, /GIT_PAGER=cat/);
});

check("does not duplicate git non-interactive environment", () => {
	const decision = decidePreventStuck("GIT_TERMINAL_PROMPT=0 git status");
	assert.equal(decision.action, "allow");
});

check("registers a bash tool_call handler and blocks through pi API", async () => {
	let handler;
	factory({ on: (event, h) => { if (event === "tool_call") handler = h; } });
	assert.equal(typeof handler, "function");
	const result = await handler({ toolName: "bash", input: { command: "nvim file.txt" } });
	assert.equal(result.block, true);
});

check("rewrites bash command in place through pi API", async () => {
	let handler;
	factory({ on: (event, h) => { if (event === "tool_call") handler = h; } });
	const event = { toolName: "bash", input: { command: "git status" } };
	const result = await handler(event);
	assert.equal(result, undefined);
	assert.match(event.input.command, /^GIT_TERMINAL_PROMPT=0/);
});

console.log(`\n${passed} checks passed.`);
