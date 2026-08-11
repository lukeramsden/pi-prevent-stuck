/**
 * pi-prevent-stuck
 *
 * Blocks or rewrites bash tool commands that are likely to hang a coding agent
 * because they need a terminal UI, pager, editor, password prompt, login prompt,
 * watch loop, or REPL.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NON_INTERACTIVE_GIT_ENV = "GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat GIT_EDITOR=: EDITOR=: VISUAL=:";

const BLOCKED_COMMANDS: Record<string, string> = {
	vi: "opens a full-screen editor",
	vim: "opens a full-screen editor",
	nvim: "opens a full-screen editor",
	nano: "opens a full-screen editor",
	pico: "opens a full-screen editor",
	emacs: "opens a full-screen editor",
	emacsclient: "opens an editor/client session",
	less: "opens an interactive pager",
	more: "opens an interactive pager",
	most: "opens an interactive pager",
	man: "opens documentation in an interactive pager",
	info: "opens documentation in an interactive browser/pager",
	top: "opens an interactive process monitor",
	htop: "opens an interactive process monitor",
	btop: "opens an interactive process monitor",
	watch: "runs until interrupted",
	tmux: "opens or controls an interactive terminal multiplexer",
	screen: "opens or controls an interactive terminal multiplexer",
	fzf: "opens an interactive fuzzy finder",
	peco: "opens an interactive selector",
	python: "starts a REPL when run without a script or command",
	python3: "starts a REPL when run without a script or command",
	python2: "starts a REPL when run without a script or command",
	node: "starts a REPL when run without a script or command",
	deno: "starts a REPL when run without a script or command",
	bun: "starts a REPL when run without a script or command",
	irb: "starts a Ruby REPL",
	pry: "starts a Ruby REPL",
	php: "starts an interactive shell with -a",
	psql: "starts an interactive database shell unless given a command/file",
	mysql: "starts an interactive database shell unless given a command/file",
	mariadb: "starts an interactive database shell unless given a command/file",
	sqlite3: "starts an interactive database shell unless given a command or input",
	"redis-cli": "starts an interactive Redis shell unless given a command",
	ssh: "opens an interactive remote shell when no remote command is provided",
	sftp: "opens an interactive file transfer shell",
	ftp: "opens an interactive file transfer shell",
};

const WRAPPERS = new Set(["sudo", "time", "command", "builtin", "nice", "stdbuf", "env"]);
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export type PreventStuckDecision =
	| { action: "allow" }
	| { action: "rewrite"; command: string }
	| { action: "block"; reason: string };

function splitSegments(command: string): string[] {
	return command.split(/&&|\|\||[;|()&\n`]|`|\$\(/);
}

function tokens(segment: string): string[] {
	return segment.trim().split(/\s+/).filter(Boolean);
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripQuotes(token: string): string {
	return token.replace(/^['"]|['"]$/g, "");
}

function commandTokenIndex(parts: string[]): number {
	let i = 0;
	while (i < parts.length) {
		const t = parts[i];
		if (isEnvAssignment(t)) {
			i++;
			continue;
		}
		if (WRAPPERS.has(t)) {
			i++;
			continue;
		}
		// Skip simple wrapper flags, e.g. sudo -n, env -u X, time -p.
		if (t.startsWith("-")) {
			i++;
			continue;
		}
		break;
	}
	return i;
}

function commandName(parts: string[]): string | undefined {
	const idx = commandTokenIndex(parts);
	return parts[idx] ? stripQuotes(parts[idx]).split("/").pop() : undefined;
}

function gitSubcommandIndex(parts: string[]): number {
	let i = commandTokenIndex(parts);
	if (parts[i] !== "git") return -1;
	i++;
	while (i < parts.length) {
		const t = parts[i];
		if (GIT_OPTS_WITH_VALUE.has(t)) {
			i += 2;
			continue;
		}
		if (t.startsWith("-")) {
			i++;
			continue;
		}
		return i;
	}
	return -1;
}

function hasInlineSequenceEditor(segment: string): boolean {
	return /\bGIT_SEQUENCE_EDITOR=\S/.test(segment) || /(?:^|\s)-c\s+sequence\.editor=\S/i.test(segment);
}

export function isInteractiveRebaseSegment(segment: string): boolean {
	if (hasInlineSequenceEditor(segment)) return false;
	const parts = tokens(segment);
	const subIdx = gitSubcommandIndex(parts);
	if (subIdx < 0 || parts[subIdx] !== "rebase") return false;
	return parts.slice(subIdx + 1).some((t) => t === "--interactive" || (/^-[^-\s]/.test(t) && t.slice(1).includes("i")));
}

function hasGitCommand(command: string): boolean {
	return splitSegments(command).some((segment) => {
		const parts = tokens(segment);
		return commandName(parts) === "git";
	});
}

function hasNonInteractiveGitPrefix(command: string): boolean {
	const trimmed = command.trim();
	return trimmed.startsWith(NON_INTERACTIVE_GIT_ENV) || /\bGIT_TERMINAL_PROMPT=0\b/.test(trimmed);
}

function phpIsInteractive(parts: string[], idx: number): boolean {
	return parts.slice(idx + 1).includes("-a");
}

function pythonLikeIsInteractive(parts: string[], idx: number): boolean {
	const args = parts.slice(idx + 1);
	return args.length === 0 || !args.some((a) => a === "-c" || a === "-m" || !a.startsWith("-"));
}

function nodeLikeIsInteractive(parts: string[], idx: number): boolean {
	const args = parts.slice(idx + 1);
	return args.length === 0 || !args.some((a) => a === "-e" || a === "--eval" || !a.startsWith("-"));
}

function databaseShellIsInteractive(command: string, parts: string[], idx: number): boolean {
	// `psql -c`, `mysql -e`, `sqlite3 db 'select 1'`, redirects, and pipes are non-interactive enough.
	if (/[|<]/.test(command)) return false;
	const name = commandName(parts);
	const args = parts.slice(idx + 1);
	if (args.some((a) => a === "-c" || a === "--command" || a === "-e" || a.startsWith("--execute=") || a === "-f" || a.startsWith("--file="))) return false;
	if (name === "sqlite3") {
		const positional = args.filter((a) => !a.startsWith("-"));
		return positional.length < 2;
	}
	return true;
}

function redisCliIsInteractive(command: string, parts: string[], idx: number): boolean {
	if (/[|<]/.test(command)) return false;
	const args = parts.slice(idx + 1).filter((a) => !a.startsWith("-"));
	return args.length === 0;
}

function sshIsInteractive(parts: string[], idx: number): boolean {
	const args = parts.slice(idx + 1);
	let nonOptionArgs = 0;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (["-b", "-c", "-D", "-E", "-F", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"].includes(a)) {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		nonOptionArgs++;
	}
	return nonOptionArgs <= 1;
}

function dockerLoginIsInteractive(parts: string[], idx: number): boolean {
	if (parts[idx] !== "docker") return false;
	const sub = parts[idx + 1];
	if (sub !== "login") return false;
	const args = parts.slice(idx + 2);
	return !args.some((a) => a === "--password-stdin" || a === "-p" || a === "--password" || a.startsWith("--password="));
}

function segmentBlockReason(segment: string): string | undefined {
	if (isInteractiveRebaseSegment(segment)) {
		return "Interactive git rebase (-i/--interactive) is blocked because it opens an editor for the todo list. Use plain `git rebase`, `git rebase --onto`, or set an inline non-interactive sequence editor such as `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`.";
	}

	const parts = tokens(segment);
	if (parts.length === 0) return undefined;
	const idx = commandTokenIndex(parts);
	const name = commandName(parts);
	if (!name) return undefined;

	if (dockerLoginIsInteractive(parts, idx)) {
		return "`docker login` is interactive unless credentials are supplied non-interactively. Use `docker login --username <user> --password-stdin` with stdin input.";
	}

	if (name === "php" && !phpIsInteractive(parts, idx)) return undefined;
	if (["python", "python3", "python2"].includes(name) && !pythonLikeIsInteractive(parts, idx)) return undefined;
	if (["node", "deno", "bun"].includes(name) && !nodeLikeIsInteractive(parts, idx)) return undefined;
	if (["psql", "mysql", "mariadb", "sqlite3"].includes(name) && !databaseShellIsInteractive(segment, parts, idx)) return undefined;
	if (name === "redis-cli" && !redisCliIsInteractive(segment, parts, idx)) return undefined;
	if (name === "ssh" && !sshIsInteractive(parts, idx)) return undefined;

	const why = BLOCKED_COMMANDS[name];
	if (!why) return undefined;
	return `\`${name}\` is blocked because it ${why} and can leave the agent stuck. Use a non-interactive command/flag instead.`;
}

export function decidePreventStuck(command: string): PreventStuckDecision {
	for (const segment of splitSegments(command)) {
		const reason = segmentBlockReason(segment);
		if (reason) return { action: "block", reason };
	}
	if (hasGitCommand(command) && !hasNonInteractiveGitPrefix(command)) {
		return { action: "rewrite", command: `${NON_INTERACTIVE_GIT_ENV} ${command}` };
	}
	return { action: "allow" };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const decision = decidePreventStuck(event.input.command);
		if (decision.action === "block") return { block: true, reason: decision.reason };
		if (decision.action === "rewrite") event.input.command = decision.command;
	});
}
