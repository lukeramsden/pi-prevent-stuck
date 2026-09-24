/**
 * pi-prevent-stuck
 *
 * Blocks or rewrites bash tool commands that actually hang a coding agent.
 *
 * pi runs the bash tool with stdin=/dev/null and stdout/stderr as pipes. In that
 * environment most "interactive" programs exit on their own: REPLs (python, node,
 * irb, sqlite3, psql...) hit EOF and quit; pagers (less, more, man) behave like cat
 * because stdout is not a TTY; tmux/screen/htop/sudo/docker login error out with
 * "not a terminal". Those are NOT blocked.
 *
 * What does hang is anything that opens /dev/tty directly or loops until killed:
 * full-screen editors, top, fzf/peco, watch, `bun repl`, and `git rebase -i`
 * with no editor override (git falls back to vi).
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NON_INTERACTIVE_GIT_ENV = "GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat GIT_EDITOR=: EDITOR=: VISUAL=:";

type Args = string[];

interface BlockRule {
	why: string;
	/** Return true when this invocation is known to be non-interactive. */
	allowIf?: (args: Args) => boolean;
}

const VERSION_OR_HELP = (args: Args) => args.some((a) => a === "--version" || a === "-v" || a === "-V" || a === "--help" || a === "-h");
const has = (args: Args, ...flags: string[]) => args.some((a) => flags.includes(a));

// vim/nvim: -es / -Es (ex silent) is the scripted mode; also -e with -s.
const vimScripted = (args: Args) => VERSION_OR_HELP(args) || args.some((a) => /^-[eE]s$/.test(a)) || (has(args, "-e", "-E") && has(args, "-s"));

const BLOCKED_COMMANDS: Record<string, BlockRule> = {
	vi: { why: "opens a full-screen editor", allowIf: vimScripted },
	vim: { why: "opens a full-screen editor", allowIf: vimScripted },
	nvim: { why: "opens a full-screen editor", allowIf: (a) => vimScripted(a) || has(a, "--headless") },
	nano: { why: "opens a full-screen editor" },
	pico: { why: "opens a full-screen editor" },
	emacs: {
		why: "opens a full-screen editor",
		allowIf: (a) => VERSION_OR_HELP(a) || has(a, "--batch", "-batch", "--script", "-script"),
	},
	emacsclient: {
		why: "blocks until the buffer is closed in the Emacs server",
		allowIf: (a) => VERSION_OR_HELP(a) || has(a, "-n", "--no-wait", "-e", "--eval"),
	},
	top: {
		why: "opens an interactive process monitor",
		// macOS: top -l N (log mode). Linux: top -b (batch), usually with -n N.
		allowIf: (a) => VERSION_OR_HELP(a) || has(a, "-l", "-b") || a.some((x) => /^-[a-zA-Z]*[lb][a-zA-Z0-9]*$/.test(x)),
	},
	watch: { why: "runs until interrupted", allowIf: VERSION_OR_HELP },
	fzf: {
		why: "opens an interactive fuzzy finder",
		allowIf: (a) => VERSION_OR_HELP(a) || has(a, "-f", "--filter") || a.some((x) => x.startsWith("--filter=") || x.startsWith("-f")),
	},
	peco: { why: "opens an interactive selector", allowIf: VERSION_OR_HELP },
};

// Interpreters whose bare form exits on EOF, but whose explicit `repl` subcommand
// may install/start a long-lived REPL (observed: `bun repl` hangs).
const REPL_SUBCOMMANDS = new Set(["bun", "deno"]);

const WRAPPERS = new Set(["sudo", "time", "command", "builtin", "nice", "stdbuf", "env", "timeout"]);
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
			// `timeout 5 cmd` — skip the duration operand too.
			if (t === "timeout" && parts[i] && /^\d/.test(parts[i])) i++;
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

function segmentBlockReason(segment: string): string | undefined {
	if (isInteractiveRebaseSegment(segment)) {
		return "Interactive git rebase (-i/--interactive) is blocked because it opens an editor for the todo list. Use plain `git rebase`, `git rebase --onto`, or set an inline non-interactive sequence editor such as `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`.";
	}

	const parts = tokens(segment);
	if (parts.length === 0) return undefined;
	const idx = commandTokenIndex(parts);
	const name = commandName(parts);
	if (!name) return undefined;
	const args = parts.slice(idx + 1);

	if (REPL_SUBCOMMANDS.has(name) && args[0] === "repl") {
		return `\`${name} repl\` is blocked because it starts a long-lived REPL and can leave the agent stuck. Use \`${name} run\`, \`${name} -e\`, or a script file instead.`;
	}

	const rule = BLOCKED_COMMANDS[name];
	if (!rule) return undefined;
	if (rule.allowIf?.(args)) return undefined;
	return `\`${name}\` is blocked because it ${rule.why} and can leave the agent stuck. Use a non-interactive command/flag instead.`;
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
