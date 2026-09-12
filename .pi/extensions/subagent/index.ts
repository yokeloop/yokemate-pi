/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, TruncatedText, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { markDoRunning, prepareDo, prepareShip, validateCoordinatorRequest, type CoordinatorRequest } from "../../../src/coordinator-launch.ts";
import { CoordinatorRegistry, ShipPermitStore, legacyCoordinatorChecks, type CoordinatorRun } from "../../../src/coordinator-runtime.ts";
import { startCoordinatorRpc } from "../../../src/coordinator-rpc.ts";
import { resolveCoordinatorModel } from "../../../src/coordinator-model.ts";
import { verifyCoordinatorOutcome } from "../../../src/coordinator-result.ts";
import { bindCoordinatorControl, processStarttime, requestCoordinator, resolveCoordinatorParent } from "../../../src/coordinator-control.ts";
import { showCoordinatorEditor } from "../../../src/coordinator-ui.ts";
import { researchChildLaunch, researchIdentity } from "../../../src/research-guard.ts";
import { ENGINE_ROOT, readGuardPolicy, readSubagentLimits, subagentAdmission, subagentConcurrency } from "../../../src/guard-policy.ts";

const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

interface Limits {
	maxParallelTasks: number;
	maxConcurrency: number;
	maxDetached: number;
}

const DEFAULT_LIMITS: Limits = { maxParallelTasks: 8, maxConcurrency: 4, maxDetached: 8 };

const limitsByCwd = new Map<string, Limits>();

function validateLimits(limits: Limits): string | undefined {
	for (const key of ["maxParallelTasks", "maxConcurrency", "maxDetached"] as const) {
		const value = limits[key];
		if (!Number.isInteger(value) || value < 1) return `${key} must be an integer >= 1, got ${JSON.stringify(value)}`;
	}
	if (limits.maxConcurrency > limits.maxParallelTasks)
		return `maxConcurrency (${limits.maxConcurrency}) must be <= maxParallelTasks (${limits.maxParallelTasks})`;
	if (limits.maxDetached < limits.maxParallelTasks)
		return `maxDetached (${limits.maxDetached}) must be >= maxParallelTasks (${limits.maxParallelTasks})`;
	return undefined;
}

// Лимиты сцеплены друг с другом, поэтому набор из настроек либо принимается
// целиком, либо отбрасывается целиком: половина от инженера, половина из кода
// дала бы комбинацию, которой никто не выбирал.
function loadLimits(cwd: string): Limits {
	const cached = limitsByCwd.get(cwd);
	if (cached) return cached;

	let limits = DEFAULT_LIMITS;
	const file = path.join(cwd, CONFIG_DIR_NAME, "settings.json");
	try {
		if (fs.existsSync(file)) {
			const raw = JSON.parse(fs.readFileSync(file, "utf-8"))?.subagent;
			if (raw && typeof raw === "object") {
				// Умолчание подгоняется под названное соседнее поле: инженер,
				// написавший один только maxParallelTasks, назвал число, а не
				// повод отказать себе умолчанием из кода.
				const maxParallelTasks = raw.maxParallelTasks ?? DEFAULT_LIMITS.maxParallelTasks;
				const candidate: Limits = {
					maxParallelTasks,
					maxConcurrency: raw.maxConcurrency ?? Math.min(DEFAULT_LIMITS.maxConcurrency, maxParallelTasks),
					maxDetached: raw.maxDetached ?? Math.max(DEFAULT_LIMITS.maxDetached, maxParallelTasks),
				};
				const problem = validateLimits(candidate);
				if (problem) console.error(`[subagent] ignoring subagent limits in ${file}: ${problem}`);
				else limits = candidate;
			}
		}
	} catch (e) {
		console.error(`[subagent] could not read subagent limits in ${file}: ${(e as Error)?.message || String(e)}`);
	}

	limitsByCwd.set(cwd, limits);
	return limits;
}

// Отвязанные дети живут дольше своего тул-колла: AbortSignal тула у них уже
// нет, и убить их некому, кроме конца сессии.
const detached = new Set<ChildProcess>();
// Ребёнок попадает в реестр только после await внутри runSingleAgent, а пачка
// тул-коллов одного хода исполняется в один тик — по одному лишь размеру
// реестра все они прошли бы потолок. Единица работы считается сразу, синхронно
// в execute, и снимается со счёта своим settle.
let activeUnits = 0;
// Уборка на session_shutdown видит только уже поднятых детей. Очередь батча
// (задачи сверх maxConcurrency) и следующий шаг цепочки поднимаются позже — в
// те миллисекунды, что pi ещё дочитывает ввод, — и осиротели бы. Флаг
// закрывает очередь; turn_start снимает его, если сессия вернулась.
let shuttingDown = false;

// Батч закрывает расширение: сколько поднято и сколько осело, знает только
// оно. Счёт, отданный модели, врёт молча — таб уйдёт дальше на неполном наборе.
type Batch = { total: number; settled: number; outcomes: { agent: string; failed: boolean }[] };
const batches = new Map<string, Batch>();

// Отвязанный вызов сворачивает тул-колл, и в ленте не остаётся ничего живого:
// кто сейчас работает, видно только отсюда — строкой над редактором.
const runningAgents = new Map<ChildProcess, { name: string; task: string; startedAt: number }>();
let widgetTimer: NodeJS.Timeout | undefined;
// ctx протухает вместе с сессией, поэтому рисуем всегда по свежему: тому, что
// пришёл в execute текущего вызова или в turn_start, а не захваченному.
let latestCtx: ExtensionContext | undefined;

function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const TASK_EXCERPT_BUDGET = 24;

// Задача сабагента — это его промт целиком: многострочный, на тысячи знаков, а
// в цепочке ещё и с подставленным отчётом предыдущего шага. В строке виджета от
// него нужен только опознавательный кусок начала, и без переводов строк: первая
// строка промта бывает служебной и у двух детей одинаковой.
function taskExcerpt(task: string): string {
	return task.replace(/\s+/g, " ").trim().slice(0, TASK_EXCERPT_BUDGET).trimEnd();
}

// Ряд показывает всех детей, только пока влезает целиком: не влез — TruncatedText
// срезает хвост, и вторая половина детей пропадает вместе с именами (на 40 колонках
// из двоих виден один). Тогда тот же список встаёт столбцом, по ребёнку на строку.
// Выбор делается в render — то есть по фактической ширине и в том же кадре, в
// который пришёл ресайз, а не по ширине на момент постановки виджета.
class RunningAgentsWidget implements Component {
	private readonly parts: string[];

	constructor(parts: string[]) {
		this.parts = parts;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const row = `⋯ ${this.parts.join(" · ")}`;
		// paddingX = 1 с обеих сторон: ряд влезает, пока строка не длиннее width - 2.
		if (visibleWidth(row) + 2 <= width) return new TruncatedText(row, 1, 0).render(width);
		return this.parts.flatMap((part) => new TruncatedText(`⋯ ${part}`, 1, 0).render(width));
	}
}

// Протухший ctx (смена сессии, /clear, форк, reload) бросает из setWidget так
// же, как из sendMessage: висящий виджет — плата, упавшая сессия — нет.
function renderRunningWidget(): void {
	if (!latestCtx) return;
	try {
		if (runningAgents.size === 0) {
			latestCtx.ui.setWidget("subagent-running", undefined);
			return;
		}
		const now = Date.now();
		const parts = Array.from(runningAgents.values()).map((a) =>
			a.task
				? `${a.name} ${formatElapsed(now - a.startedAt)} ${a.task}`
				: `${a.name} ${formatElapsed(now - a.startedAt)}`,
		);
		latestCtx.ui.setWidget("subagent-running", () => new RunningAgentsWidget(parts));
	} catch (e) {
		console.error(`[subagent] widget not drawn: ${(e as Error)?.message || String(e)}`);
	}
}

function stopWidgetTimer(): void {
	if (!widgetTimer) return;
	clearInterval(widgetTimer);
	widgetTimer = undefined;
}

function trackRunning(proc: ChildProcess, name: string, task: string): void {
	runningAgents.set(proc, { name, task: taskExcerpt(task), startedAt: Date.now() });
	if (!widgetTimer) {
		widgetTimer = setInterval(renderRunningWidget, 1000);
		widgetTimer.unref();
	}
	renderRunningWidget();
}

function untrackRunning(proc: ChildProcess | undefined): void {
	if (proc) runningAgents.delete(proc);
	if (runningAgents.size === 0) stopWidgetTimer();
	renderRunningWidget();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onSpawn?: (proc: ChildProcess) => void,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--extension", path.join(ENGINE_ROOT, "src", "guards.ts")];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	const research = researchIdentity();
	if (!research && agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (research) args.push("--no-extensions", "--no-tools", "-e", path.join(research.root, "src", "research.ts"));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const coordinatorChild = process.env.YOKEMATE_ROLE === "coordinator";
		if (coordinatorChild) {
			const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
			args.push("--no-approve", "-e", path.join(root, "src", "guards.ts"), "-e", path.join(root, ".pi", "extensions", "subagent", "index.ts"), "--skill", path.join(root, ".pi", "skills"));
		}
		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const child = research
				? researchChildLaunch(research, cwd ?? defaultCwd, [research.root, ...(research.projectPath ? [research.projectPath] : [])])
				: undefined;
			const env: NodeJS.ProcessEnv = {
				...process.env,
				YOKEMATE_ROLE: "executor",
				YOKEMATE_RUN_ID: randomUUID(),
				...(process.env.YOKEMATE_RUN_ID ? { YOKEMATE_PARENT_RUN_ID: process.env.YOKEMATE_RUN_ID } : {}),
				...(child?.env ?? {}),
			};
			if (coordinatorChild) {
				env.YOKEMATE_PARENT_RUN_ID = process.env.YOKEMATE_RUN_ID;
				env.YOKEMATE_RUN_ID = randomUUID();
			}
			delete env.HERDR_PANE_ID;
			delete env.YOKEMATE_PARENT_PANE;
			const proc = spawn(invocation.command, invocation.args, {
				cwd: child?.cwd ?? cwd ?? defaultCwd,
				env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			onSpawn?.(proc);
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project". Use "both" to include the user-level ones.',
	default: "project",
});

const CoordinatorRequestSchema = Type.Object({
	mode: StringEnum(["do", "ship"] as const),
	tickets: Type.Array(Type.String()),
	plan: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
});

const SubagentParams = Type.Object({
	coordinator: Type.Optional(CoordinatorRequestSchema),
	cancelRun: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const coordinators = new CoordinatorRegistry();
	const shipPermits = new ShipPermitStore();
	const rpcByRun = new Map<string, ReturnType<typeof startCoordinatorRpc>>();
	const coordinatorUnits = new Set<string>();
	const releaseCoordinatorUnit = (runId: string): void => {
		if (coordinatorUnits.delete(runId)) activeUnits -= 1;
	};
	let controlServer: import("node:net").Server | undefined;
	let controlIdentity: { sessionId: string; runtimeId: string } | undefined;
	let uiTail: Promise<void> = Promise.resolve();
	const uiAbortByRun = new Map<string, AbortController>();
	let ownedReadyRunId: string | undefined;
	let finishingCoordinatorRunId: string | undefined;
	pi.on("input", (event, ctx) => {
		const text = event.text.trim();
		const match = event.source === "interactive" ? text.match(/^\/ship\s+(.+)$/) : undefined;
		if (match && !process.env.YOKEMATE_MODE) {
			const tickets = match[1].split(/\s+/).filter((word) => /^[A-Z][A-Z0-9]*-\d+$/.test(word));
			if (tickets.length) shipPermits.observeInteractiveShip(tickets, (ctx as any).sessionManager?.getSessionId?.() ?? "main");
		} else shipPermits.invalidate();
	});
	const startCoordinator = async (request: CoordinatorRequest, ctx: ExtensionContext, origin: { YOKEMATE_MODE?: string; YOKEMATE_TICKET?: string; YOKEMATE_ROLE?: "coordinator" | "executor"; sessionId?: string; cwd?: string }) => {
		const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
		const checks = legacyCoordinatorChecks(loadLimits(root).maxDetached);
		validateCoordinatorRequest(request);
		const refusal = checks.checkCaller(origin, request);
		if (refusal) throw new Error(refusal);
		if (request.mode === "ship") {
			if (!shipPermits.consume(request.tickets, origin.sessionId ?? "main")) throw new Error("ship requires the current interactive /ship command in the main chat");
			if (checks.needsShipConfirmation(origin) && (!ctx.hasUI || !(await ctx.ui.confirm("Ship merges", "Confirm this run is on the engineer's word.")))) throw new Error("ship confirmation declined");
		}
		const duplicate = checks.checkDuplicate(request.mode, coordinators.active().filter((active) => active.request.tickets.some((ticket) => request.tickets.includes(ticket))));
		if (duplicate) throw new Error(duplicate);
		const admission = checks.checkAdmission(activeUnits);
		if (admission) throw new Error(admission);
		activeUnits += 1;
		let run: CoordinatorRun | undefined;
		let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
		let reportBlocked: ((reason: string) => void) | undefined;
		const finishCalls = new Set<string>();
		try {
			run = coordinators.reserve(request, origin, origin.sessionId ?? "main", request.model ?? "pending", request.mode === "do" ? path.join(root, "work", request.tickets[0]!) : root, []);
			if (!run) throw new Error("coordinator reservation failed");
			const ownedRun = run;
			coordinatorUnits.add(ownedRun.identity.runId);
			const prepared = request.mode === "do" ? prepareDo(root, request, origin) : await prepareShip(root, request);
			ownedRun.identity.model = prepared.model;
			ownedRun.identity.cwd = prepared.cwd;
			ownedRun.identity.project = prepared.parts.map((part) => part.repo);
			coordinators.setPrepared(ownedRun.identity.runId, prepared);
			let terminalReported = false;
			let nudgeSent = false;
			reportBlocked = (reason: string) => {
				if (terminalReported) return;
				terminalReported = true;
				uiAbortByRun.get(ownedRun.identity.runId)?.abort();
				uiAbortByRun.delete(ownedRun.identity.runId);
				const blocked = coordinators.finalize(ownedRun.identity.runId, "blocked", reason);
				releaseCoordinatorUnit(ownedRun.identity.runId);
				const verification = verifyCoordinatorOutcome(root, prepared, { outcome: "blocked", summary: "coordinator stopped", reason }, 0);
				pi.appendEntry("yokemate-coordinator-run", { identity: blocked.identity, state: "blocked", verification, summary: "coordinator stopped", reason });
				pi.sendMessage({ customType: "subagent-report", content: `[coordinator ${blocked.identity.mode} ${blocked.identity.ticket}] blocked: ${reason}`, display: true, details: { runId: blocked.identity.runId, mode: blocked.identity.mode, tickets: blocked.request.tickets, outcome: "blocked", verification } }, { deliverAs: "followUp", triggerTurn: true });
				rpcByRun.delete(ownedRun.identity.runId);
			};
			const resolvedModel = resolveCoordinatorModel(prepared.model, ctx.modelRegistry);
			if (resolvedModel.warning) ctx.ui.notify(resolvedModel.warning, "warning");
			if (request.mode === "do") markDoRunning(root, prepared, origin);
			rpc = startCoordinatorRpc(prepared, ownedRun.identity, resolvedModel.expected, { onEvent: (event) => {
				if (event.type === "agent_start") { nudgeSent = false; return; }
				if (event.type === "agent_settled" && !terminalReported) {
					if (nudgeSent) { reportBlocked?.("coordinator stopped without outcome"); return; }
					nudgeSent = true;
					void rpc?.request({ type: "prompt", message: "Continue the pipeline or call coordinator_finish with a verified outcome.", streamingBehavior: "followUp" }).catch((error) => reportBlocked?.((error as Error).message));
					return;
				}
				if (event.type === "tool_execution_start" && event.toolName === "coordinator_finish" && typeof event.toolCallId === "string") { finishCalls.add(event.toolCallId); return; }
				const result = event.type === "tool_execution_end" ? (event.result as { details?: { kind?: string; runId?: string; outcome?: "done" | "blocked"; summary?: string; reason?: string } } | undefined) : undefined;
				if (event.type !== "tool_execution_end" || event.toolName !== "coordinator_finish" || event.isError || typeof event.toolCallId !== "string" || !finishCalls.delete(event.toolCallId) || result?.details?.kind !== "yokemate-coordinator-outcome" || result.details.runId !== ownedRun.identity.runId || !result.details.outcome || terminalReported) return;
				terminalReported = true;
				const proposal = { outcome: result.details.outcome, summary: result.details.summary ?? "coordinator finished", reason: result.details.reason };
				const verification = verifyCoordinatorOutcome(root, prepared, proposal, 0);
				if (!verification.ok) {
					terminalReported = false;
					void rpc?.request({ type: "prompt", message: `coordinator_finish was not verified: ${verification.reason ?? "missing facts"}. Continue the pipeline or finish blocked.`, streamingBehavior: "followUp" }).catch(() => {});
					return;
				}
				rpc?.acceptTerminal();
				uiAbortByRun.get(ownedRun.identity.runId)?.abort();
				uiAbortByRun.delete(ownedRun.identity.runId);
				coordinators.finalize(ownedRun.identity.runId, proposal.outcome, proposal.reason);
				releaseCoordinatorUnit(ownedRun.identity.runId);
				pi.appendEntry("yokemate-coordinator-run", { identity: ownedRun.identity, state: proposal.outcome, verification, summary: proposal.summary, reason: proposal.reason });
				pi.sendMessage({ customType: "subagent-report", content: `[coordinator ${ownedRun.identity.mode} ${ownedRun.identity.ticket}] ${proposal.outcome}: ${proposal.summary}`, display: true, details: { runId: ownedRun.identity.runId, mode: ownedRun.identity.mode, tickets: ownedRun.request.tickets, outcome: proposal.outcome, verification } }, { deliverAs: "followUp", triggerTurn: true });
				void rpcByRun.get(ownedRun.identity.runId)?.stop(); rpcByRun.delete(ownedRun.identity.runId);
			}, onUiRequest: (event, reply) => {
				const request = event as { id?: string; method?: string; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string };
				if (!request.id || !["select", "confirm", "input", "editor"].includes(request.method ?? "")) return;
				const controller = uiAbortByRun.get(ownedRun.identity.runId) ?? new AbortController();
				uiAbortByRun.set(ownedRun.identity.runId, controller);
				uiTail = uiTail.then(async () => {
					const id = request.id!;
					const live = () => !controller.signal.aborted && !["done", "blocked"].includes(coordinators.get(ownedRun.identity.runId)?.state ?? "blocked");
					try {
						if (!ctx.hasUI || !live()) { reply({ type: "extension_ui_response", id, cancelled: true }); return; }
						const options = { signal: controller.signal };
						const value = request.method === "confirm"
							? await ctx.ui.confirm(request.title ?? "Coordinator", request.message ?? "", options)
							: request.method === "select"
								? await ctx.ui.select(request.title ?? "Coordinator", request.options ?? [], options)
								: request.method === "input"
									? await ctx.ui.input(request.title ?? "Coordinator", request.placeholder, options)
									: await showCoordinatorEditor(ctx, request.title ?? "Coordinator", request.prefill, controller.signal);
						if (!live() || value === undefined || value === false) reply({ type: "extension_ui_response", id, cancelled: true });
						else if (request.method === "confirm") reply({ type: "extension_ui_response", id, confirmed: true });
						else reply({ type: "extension_ui_response", id, value });
					} catch { reply({ type: "extension_ui_response", id, cancelled: true }); }
				}).catch(() => {});
			}, onBlocked: reportBlocked });
			rpcByRun.set(ownedRun.identity.runId, rpc);
			await rpc.ready;
			coordinators.attachProcess(ownedRun.identity.runId, rpc.process);
			const work = await rpc.request({ id: `${ownedRun.identity.runId}:work`, type: "prompt", message: prepared.prompt });
			if (work.success !== true) throw new Error(`coordinator work prompt was refused: ${String(work.error ?? "unknown error")}`);
			return { content: [{ type: "text", text: `accepted ${ownedRun.identity.runId}, model ${prepared.model}, cwd ${prepared.cwd}` }], details: { runId: ownedRun.identity.runId, identity: ownedRun.identity } };
		} catch (error) {
			if (run) {
				uiAbortByRun.get(run.identity.runId)?.abort();
				uiAbortByRun.delete(run.identity.runId);
				await rpc?.stop();
				reportBlocked?.((error as Error).message);
			} else activeUnits -= 1;
			throw error;
		}
	};
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		if (process.env.YOKEMATE_MODE || process.env.YOKEMATE_ROLE) return;
		const sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "main";
		const runtimeId = randomUUID();
		controlIdentity = { sessionId, runtimeId };
		try {
			controlServer = bindCoordinatorControl(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), {
				launch: async (request, controlOrigin) => {
					const origin = { YOKEMATE_MODE: controlOrigin.mode, YOKEMATE_TICKET: controlOrigin.ticket, YOKEMATE_ROLE: controlOrigin.role as "coordinator" | "executor" | undefined, sessionId: controlOrigin.sessionId, cwd: controlOrigin.cwd };
					const result = await startCoordinator(request, ctx, origin);
					if ((result as { isError?: boolean }).isError) throw new Error((result.content[0] as { text?: string } | undefined)?.text ?? "coordinator launch refused");
					const details = result.details as { runId?: string; identity?: unknown } | undefined;
					if (!details?.runId) throw new Error("coordinator launch did not return a run id");
					return { runId: details.runId, identity: details.identity };
				},
				status: (requestId, _origin) => {
					const runId = requestId;
					const run = coordinators.get(runId);
					return run ? { requestId, state: "status", runId, identity: run.identity, reason: run.state } : { requestId, state: "refused", reason: "unknown coordinator request" };
				},
				cancel: async (runId, _origin) => { const run = coordinators.cancel(runId); await rpcByRun.get(run.identity.runId)?.stop(); rpcByRun.delete(run.identity.runId); },
			}, { root: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), sessionId, runtimeId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", cwd: ctx.cwd, pane: process.env.HERDR_PANE_ID });
		} catch (error) { ctx.ui.notify(`coordinator control is not up: ${(error as Error).message}`, "warning"); }
	});
	pi.registerCommand("yokemate-coordinator-ready", {
		description: "Initialize an owned coordinator RPC runtime.",
		handler: async (args, ctx) => {
			try {
				const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8")) as { identity?: { runId?: string; role?: string; cwd?: string }; prepared?: { cwd?: string } };
				const identity = payload.identity;
				if (!identity || identity.role !== "coordinator" || identity.runId !== process.env.YOKEMATE_RUN_ID || identity.cwd !== ctx.cwd || payload.prepared?.cwd !== ctx.cwd || !ctx.isProjectTrusted()) throw new Error("invalid coordinator ready identity");
				const commands = pi.getCommands().map((command) => command.name);
				if (!commands.includes(`skill:${process.env.YOKEMATE_MODE}-worker`)) throw new Error("worker skill unavailable");
				ownedReadyRunId = identity.runId;
				pi.sendMessage({ customType: "yokemate-coordinator-ready", content: "ready", display: false, details: { runId: identity.runId, ok: true } }, { deliverAs: "followUp", triggerTurn: false });
			} catch (error) {
				pi.sendMessage({ customType: "yokemate-coordinator-ready", content: "blocked", display: false, details: { ok: false, reason: (error as Error).message } }, { deliverAs: "followUp", triggerTurn: false });
			}
		},
	});
	pi.on("session_shutdown", () => {
		controlServer?.close();
		controlServer = undefined;
		controlIdentity = undefined;
		for (const controller of uiAbortByRun.values()) controller.abort();
		uiAbortByRun.clear();
		for (const runId of coordinatorUnits) releaseCoordinatorUnit(runId);
		for (const rpc of rpcByRun.values()) void rpc.stop();
		rpcByRun.clear();
		for (const proc of detached) {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}
		shuttingDown = true;
		detached.clear();
		batches.clear();
		runningAgents.clear();
		stopWidgetTimer();
		renderRunningWidget();
	});

	pi.on("turn_start", (_event, ctx) => {
		shuttingDown = false;
		latestCtx = ctx;
		renderRunningWidget();
	});

	// Отчёт приходит из отложенного колбэка: ловить бросок отсюда некому, и
	// протухший ctx уронил бы весь процесс pi вместе с самим отчётом.
	const sendReport = (content: string): void => {
		try {
			pi.sendMessage(
				{ customType: "subagent-report", content, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (e) {
			console.error(`[subagent] report lost: ${(e as Error)?.message || String(e)}\n${content}`);
		}
	};

	const reportDetached = (agentName: string, failed: boolean, text: string): void => {
		sendReport(`[subagent ${agentName}${failed ? " failed" : ""}] ${text || "(no output)"}`);
	};

	const openBatch = (batchId: string, total: number): void => {
		batches.set(batchId, { total, settled: 0, outcomes: [] });
	};

	const settleBatch = (batchId: string, agentName: string, failed: boolean): void => {
		const batch = batches.get(batchId);
		if (!batch) return;
		batch.settled += 1;
		batch.outcomes.push({ agent: agentName, failed });
		if (batch.settled < batch.total) return;
		batches.delete(batchId);
		const outcomes = batch.outcomes.map((o) => `${o.agent} ${o.failed ? "failed" : "✓"}`).join(" · ");
		sendReport(`[subagent batch complete] ${batch.settled}/${batch.total} · ${outcomes}`);
	};

	pi.registerTool({
		name: "coordinator_finish",
		label: "Coordinator finish",
		description: "Finish this owned background coordinator with a verified outcome.",
		parameters: Type.Object({ outcome: StringEnum(["done", "blocked"] as const), summary: Type.String(), reason: Type.Optional(Type.String()), passedTickets: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params): Promise<any> {
			const runId = process.env.YOKEMATE_RUN_ID;
			if (!runId || process.env.YOKEMATE_ROLE !== "coordinator" || ownedReadyRunId !== runId)
				return { content: [{ type: "text", text: "coordinator_finish is available only to its owned RPC coordinator" }], isError: true };
			if (params.outcome === "blocked" && !params.reason)
				return { content: [{ type: "text", text: "blocked needs a reason" }], isError: true };
			if (finishingCoordinatorRunId) return { content: [{ type: "text", text: "coordinator is already finishing" }], isError: true };
			if (batches.size > 0) return { content: [{ type: "text", text: "coordinator still has active child batches" }], isError: true };
			const run = coordinators.get(runId);
			if (!run) {
				finishingCoordinatorRunId = runId;
				return { content: [{ type: "text", text: "outcome proposed" }], details: { kind: "yokemate-coordinator-outcome", runId, outcome: params.outcome, summary: params.summary, reason: params.reason, passedTickets: params.passedTickets }, terminate: true };
			}
			const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
			const verification = verifyCoordinatorOutcome(root, run.prepared!, params, batches.size);
			if (!verification.ok)
				return { content: [{ type: "text", text: verification.reason ?? "outcome cannot be verified" }], isError: true };
			finishingCoordinatorRunId = runId;
			coordinators.finalize(runId, params.outcome, params.reason);
			pi.appendEntry("yokemate-coordinator-run", { identity: run.identity, state: params.outcome, verification, summary: params.summary, reason: params.reason });
			pi.sendMessage({ customType: "subagent-report", content: `[coordinator ${run.identity.mode} ${run.identity.ticket}] ${params.outcome}: ${params.summary}`, display: true, details: { runId, mode: run.identity.mode, tickets: run.request.tickets, outcome: params.outcome, verification } }, { deliverAs: "followUp", triggerTurn: true });
			void rpcByRun.get(runId)?.stop();
			rpcByRun.delete(runId);
			return { content: [{ type: "text", text: `${params.outcome} verified` }], details: { kind: "yokemate-coordinator-outcome", runId, outcome: params.outcome, verification }, terminate: true };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Agents come from the nearest ${CONFIG_DIR_NAME}/agents — the yokemate root in the main chat, work/<TICKET>/${CONFIG_DIR_NAME}/agents in the task tab.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
			latestCtx = ctx;
			if (finishingCoordinatorRunId && process.env.YOKEMATE_ROLE === "coordinator") return { content: [{ type: "text", text: "coordinator is finishing" }], isError: true };
			const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
			const sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "main";
			if (params.cancelRun) {
				try { const run = coordinators.cancel(params.cancelRun); uiAbortByRun.get(run.identity.runId)?.abort(); uiAbortByRun.delete(run.identity.runId); void rpcByRun.get(run.identity.runId)?.stop(); rpcByRun.delete(run.identity.runId); return { content: [{ type: "text", text: `${run.identity.runId} cancelled` }] }; }
				catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			}
			if (params.coordinator) {
				const origin = { YOKEMATE_MODE: process.env.YOKEMATE_MODE, YOKEMATE_TICKET: process.env.YOKEMATE_TICKET, YOKEMATE_ROLE: process.env.YOKEMATE_ROLE as "coordinator" | "executor" | undefined, sessionId, cwd: ctx.cwd };
				try {
					if (process.env.YOKEMATE_MODE) {
						const parent = resolveCoordinatorParent(root);
						const reply = await requestCoordinator(root, params.coordinator as CoordinatorRequest, {
							sessionId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", cwd: ctx.cwd,
							pane: process.env.HERDR_PANE_ID, parentPane: process.env.YOKEMATE_PARENT_PANE,
							mode: process.env.YOKEMATE_MODE, ticket: process.env.YOKEMATE_TICKET, role: process.env.YOKEMATE_ROLE,
						}, parent);
						if (reply.state !== "accepted" || !reply.runId) throw new Error(reply.reason ?? "coordinator launch was not accepted");
						return { content: [{ type: "text", text: `accepted ${reply.runId}` }], details: { runId: reply.runId, identity: reply.identity } };
					}
					return await startCoordinator(params.coordinator as CoordinatorRequest, ctx, origin);
				} catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			}
			const agentScope: AgentScope = params.agentScope ?? "project";
			let policy;
			try {
				policy = readGuardPolicy(ENGINE_ROOT);
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { mode: "single", agentScope, projectAgentsDir: null, results: [] }, isError: true };
			}
			const limits = readSubagentLimits(ENGINE_ROOT);
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? false;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// Один ребёнок, отвязанный: тул-колл уже вернулся, поэтому исход
			// доходит только сообщением, и своим на каждого агента.
			const runDetachedAgent = async (
				mode: "single" | "parallel",
				agentName: string,
				task: string,
				taskCwd: string | undefined,
				formatOutput: (result: SingleResult) => string,
			): Promise<void> => {
				if (shuttingDown) {
					activeUnits -= 1;
					console.error(`[subagent] ${agentName} dropped from the queue at shutdown, it never ran`);
					return;
				}
				let child: ChildProcess | undefined;
				// Убитый сигналом ребёнок закрывается с code === null, а
				// runSingleAgent превращает его в exitCode 0 — без этого флага
				// снятый руками процесс отчитался бы как успех.
				let killedBySignal = false;
				const settle = (failed: boolean, text: string) => {
					activeUnits -= 1;
					if (child) detached.delete(child);
					untrackRunning(child);
					reportDetached(agentName, failed || killedBySignal, text);
					settleBatch(toolCallId, agentName, failed || killedBySignal);
				};
				let failed: boolean;
				let text: string;
				try {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						agentName,
						task,
						taskCwd,
						undefined, // step
						undefined, // signal: тул-колл уже вернулся, отменять нечем
						undefined, // onUpdate: рисовать некуда, тул-колл свёрнут
						makeDetails(mode),
						(proc) => {
							child = proc;
							detached.add(proc);
							trackRunning(proc, agentName, task);
							proc.once("close", (_code, signalName) => {
								if (signalName) killedBySignal = true;
								detached.delete(proc);
							});
						},
					);
					failed = isFailedResult(result);
					text = formatOutput(result);
				} catch (e) {
					failed = true;
					text = (e as Error)?.message || String(e);
				}
				// Один вызов settle на все исходы: из try он мог бы уйти в свой
				// же catch и отчитаться дважды.
				settle(failed, text);
			};

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				policy.guards.projectAgentConfirmation &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const steps = params.chain;
				const admission = subagentAdmission(policy, limits, "chain", 1, activeUnits);
				if (admission) {
					return {
						content: [{ type: "text", text: admission }],
						details: makeDetails("chain")([]),
						isError: true,
					};
				}

				activeUnits += 1;
				openBatch(toolCallId, 1);

				// Цепочка — одна единица: каждый шаг питается {previous}
				// предыдущего, промежуточный вывод сам по себе не результат.
				// Отсюда один отчёт, в конце, и одна запись в батче.
				const runChain = async (): Promise<void> => {
					let previousOutput = "";
					let lastAgent = steps[steps.length - 1].agent;
					const settle = (failed: boolean, agentName: string, text: string) => {
						activeUnits -= 1;
						reportDetached(failed ? "chain" : agentName, failed, text);
						settleBatch(toolCallId, agentName, failed);
					};

					for (let i = 0; i < steps.length; i++) {
						if (shuttingDown) {
							activeUnits -= 1;
							console.error(
								`[subagent] chain dropped at shutdown before step ${i + 1} (${steps[i].agent}), it never ran`,
							);
							return;
						}
						const step = steps[i];
						lastAgent = step.agent;
						const stepTask = step.task.replace(/\{previous\}/g, previousOutput);
						let killedBySignal = false;
						let result: SingleResult;
						try {
							result = await runSingleAgent(
								ctx.cwd,
								dispatchDefaults,
								agents,
								step.agent,
								stepTask,
								step.cwd,
								i + 1,
								undefined, // signal: тул-колл уже вернулся, отменять нечем
								undefined, // onUpdate: рисовать некуда, тул-колл свёрнут
								makeDetails("chain"),
								(proc) => {
									detached.add(proc);
									trackRunning(proc, step.agent, stepTask);
									proc.once("close", (_code, signalName) => {
										if (signalName) killedBySignal = true;
										detached.delete(proc);
										untrackRunning(proc);
									});
								},
							);
						} catch (e) {
							settle(true, step.agent, `шаг ${i + 1} (${step.agent}): ${(e as Error)?.message || String(e)}`);
							return;
						}
						if (isFailedResult(result) || killedBySignal) {
							settle(true, step.agent, `шаг ${i + 1} (${step.agent}): ${getResultOutput(result)}`);
							return;
						}
						previousOutput = getFinalOutput(result.messages);
					}
					settle(false, lastAgent, previousOutput);
				};
				void runChain().catch((e) => console.error(`[subagent] chain failed: ${(e as Error)?.message || String(e)}`));

				const names = steps.map((step) => step.agent).join(" → ");
				return {
					content: [
						{
							type: "text",
							text: `Detached: chain of ${steps.length} steps running (${names}). Its report will arrive as a separate message.`,
						},
					],
					details: makeDetails("chain")([]),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks;
				const admission = subagentAdmission(policy, limits, "parallel", tasks.length, activeUnits);
				if (admission) {
					return {
						content: [{ type: "text", text: admission }],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				activeUnits += tasks.length;
				openBatch(toolCallId, tasks.length);
				void mapWithConcurrencyLimit(tasks, subagentConcurrency(policy, limits, tasks.length), (t) =>
					runDetachedAgent("parallel", t.agent, t.task, t.cwd, (r) => truncateParallelOutput(getResultOutput(r))),
				).catch((e) => console.error(`[subagent] parallel batch failed: ${(e as Error)?.message || String(e)}`));

				const names = tasks.map((t) => t.agent).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Detached: ${tasks.length} agents running (${names}). Their reports will arrive as separate messages prefixed "[subagent <name>]" — do not call subagent again for these tasks.`,
						},
					],
					details: makeDetails("parallel")([]),
				};
			}

			if (params.agent && params.task) {
				const admission = subagentAdmission(policy, limits, "single", 1, activeUnits);
				if (admission) {
					return {
						content: [{ type: "text", text: admission }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const agentName = params.agent;
				activeUnits += 1;
				openBatch(toolCallId, 1);
				void runDetachedAgent("single", agentName, params.task, params.cwd, getResultOutput);
				return {
					content: [
						{
							type: "text",
							text: `Detached: ${agentName} is running. Its report will arrive as a separate message prefixed "[subagent ${agentName}]" — do not call subagent again for this task.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
