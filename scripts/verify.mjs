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

const blocks = [
	"git rebase -i HEAD~3",
	"git rebase --interactive main",
	"echo ok && git -C repo rebase -ir main",
	"vim src/app.ts",
	"less huge.log",
	"man git",
	"top",
	"watch npm test",
	"python",
	"node",
	"php -a",
	"psql mydb",
	"mysql -u root",
	"redis-cli",
	"docker login -u luke",
	"ssh prod-box",
];

for (const cmd of blocks) {
	check(`blocks ${cmd}`, () => assert.equal(decidePreventStuck(cmd).action, "block"));
}

const allowed = [
	"GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main",
	"git -c sequence.editor=true rebase -i main",
	"python -c 'print(1)'",
	"python script.py",
	"node -e 'console.log(1)'",
	"node script.js",
	"php script.php",
	"psql -c 'select 1'",
	"mysql -e 'select 1'",
	"sqlite3 db.sqlite 'select 1'",
	"redis-cli ping",
	"docker login --username foo --password-stdin < token.txt",
	"ssh prod-box 'uname -a'",
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
