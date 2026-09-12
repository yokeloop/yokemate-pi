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
import { createHash, randomUUID } from "node:crypto";
import { deliveryFor, reportContent, type ReportDelivery, type ReportEnvelope, RunSnapshots, errorMetadata, fileProvenance, JsonlObservation, ChildRuns, resultEnvelope, failedEnvelope, sha256, type ChildIdentity, type ResultEnvelope, type BatchEnvelope, type LaunchAck } from "../../../src/subagent-runs.ts";
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
import { continueOwnedCoordinator, startCoordinatorRpc } from "../../../src/coordinator-rpc.ts";
import { resolveCoordinatorModel } from "../../../src/coordinator-model.ts";
import { verifyCoordinatorOutcome } from "../../../src/coordinator-result.ts";
import { bindCoordinatorControl, processStarttime, requestCoordinator, resolveCoordinatorParent } from "../../../src/coordinator-control.ts";
import { showCoordinatorEditor } from "../../../src/coordinator-ui.ts";
import { researchChildLaunch, researchIdentity } from "../../../src/research-guard.ts";
import { ENGINE_ROOT, readGuardPolicy, readSubagentLimits, subagentAdmission, subagentConcurrency } from "../../../src/guard-policy.ts";

const COLLAPSED_ITEM_COUNT = 10;

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
const cancellationByProcess = new Map<ChildProcess, (initiator: string) => void>();
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
const batches = new Set<string>();

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
	envelope?: ResultEnvelope;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number | null;
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
	batchId?: string;
	children?: LaunchAck["children"];
}

function getFinalOutput(messages: Message[]): string {
	const last = messages.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.envelope ? failedEnvelope(result.envelope) : result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
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
	onSpawn: ((proc: ChildProcess) => void) | undefined,
	identity: ChildIdentity,
	diagnostic: { metadata: Record<string, unknown>; save(completed: boolean): void },
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

	const coordinatorChild = process.env.YOKEMATE_ROLE === "coordinator";
	const args: string[] = ["--mode", "json", "-p", ...(coordinatorChild ? ["--session-dir", path.join(process.cwd(), "sessions")] : ["--no-session"]), "--extension", path.join(ENGINE_ROOT, "src", "guards.ts")];
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

		if (coordinatorChild) {
			const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
			args.push("--no-approve", "-e", path.join(root, "src", "guards.ts"), "-e", path.join(root, ".pi", "extensions", "subagent", "index.ts"), "--skill", path.join(root, ".pi", "skills"));
		}
		args.push(`Task: ${task}`);
		diagnostic.metadata.launch = fileProvenance(getPiInvocation(args).args[0] ?? process.execPath);
		diagnostic.metadata.appendedPromptHash = sha256(agent.systemPrompt);
		diagnostic.metadata.agentDefinition = fileProvenance(agent.filePath);
		diagnostic.metadata.requested = { model, thinking: inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : "unknown" };
		let stderrBytes = 0;
		const stderrHash = createHash("sha256");
		const observation = new JsonlObservation((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const msg = event.message as Message;
				currentResult.messages = [msg];
				if (msg.role === "assistant") {
					currentResult.stopReason = msg.stopReason;
					currentResult.model = msg.model;
					currentResult.usage.turns++;
					if (msg.usage) {
						currentResult.usage.input += msg.usage.input || 0;
						currentResult.usage.output += msg.usage.output || 0;
						currentResult.usage.cacheRead += msg.usage.cacheRead || 0;
						currentResult.usage.cacheWrite += msg.usage.cacheWrite || 0;
						currentResult.usage.cost += msg.usage.cost?.total || 0;
						currentResult.usage.contextTokens = msg.usage.totalTokens || 0;
					}
				}
				emitUpdate();
			}
		});
		const terminal = await new Promise<{ exitCode: number | null; signal: string | null; processOutcome: "exited" | "signaled" | "spawn_error" | "cancelled" }>((resolve) => {
			const invocation = getPiInvocation(args);
			const child = research ? researchChildLaunch(research, identity.cwd, [research.root, ...(research.projectPath ? [research.projectPath] : [])]) : undefined;
			const env: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_ROLE: "executor", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_RUN_ID: identity.ownerRunId, ...(child?.env ?? {}) };
			delete env.HERDR_PANE_ID;
			delete env.YOKEMATE_PARENT_PANE;
			let spawnError: Error | undefined;
			let cancelled = false;
			let killTimer: NodeJS.Timeout | undefined;
			const proc = spawn(invocation.command, invocation.args, { cwd: child?.cwd ?? identity.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			diagnostic.metadata.pid = proc.pid;
			diagnostic.metadata.starttime = proc.pid ? processStarttime(proc.pid) : undefined;
			diagnostic.metadata.spawnAt = new Date().toISOString();
			cancellationByProcess.set(proc, (initiator) => { cancelled = true; diagnostic.metadata.cancellationInitiator = initiator; diagnostic.save(false); });
			diagnostic.save(false);
			onSpawn?.(proc);
			const abort = () => {
				cancellationByProcess.get(proc)?.("tool_abort_signal");
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }, 5000);
			};
			proc.stdout.on("data", (data: Buffer) => observation.write(data));
			proc.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; stderrHash.update(data); currentResult.stderr = "child stderr observed"; });
			proc.on("error", (error) => { spawnError = error; diagnostic.metadata.spawnError = errorMetadata(error); });
			proc.once("close", (exitCode, signalName) => {
				clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				observation.end();
				cancellationByProcess.delete(proc);
				diagnostic.metadata.closeAt = new Date().toISOString();
				resolve({ exitCode, signal: signalName, processOutcome: cancelled ? "cancelled" : spawnError ? "spawn_error" : signalName ? "signaled" : "exited" });
			});
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
		currentResult.exitCode = terminal.exitCode;
		currentResult.envelope = resultEnvelope(identity, task, { ...terminal, stopReason: observation.stopReason, protocolError: observation.protocolError, incomplete: observation.incomplete }, observation.finalText);
		diagnostic.metadata.stream = observation.metadata();
		diagnostic.metadata.stderr = { bytes: stderrBytes, hash: stderrHash.digest("hex") };
		diagnostic.metadata.sessionId = observation.sessionId;
		diagnostic.metadata.effective = { model: observation.model ?? "unknown", provider: observation.provider ?? "unknown", thinking: "unknown" };
		diagnostic.metadata.terminal = { ...terminal, stopReason: observation.stopReason };
		diagnostic.metadata.payload = { outcome: currentResult.envelope.payloadOutcome, bytes: Buffer.byteLength(observation.finalText), hash: sha256(observation.finalText), verdict: currentResult.envelope.reviewVerdict };
		diagnostic.save(true);
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

const ReviewRevisionSchema = Type.Object({ baseSha: Type.String(), headSha: Type.String() });

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	review: Type.Optional(ReviewRevisionSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	review: Type.Optional(ReviewRevisionSchema),
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
	review: Type.Optional(ReviewRevisionSchema),
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
	let runs: ChildRuns | undefined;
	let snapshots: RunSnapshots | undefined;
	const diagnostics = new Map<string, { metadata: Record<string, unknown>; save(completed: boolean): void }>();
	const sentBatches = new Set<string>();
	const deliveries = new Map<string, { delivery: ReportDelivery; envelope: ReportEnvelope }>();
	let childSequence = 0;
	const emitChildState = () => {
		if (!runs) return;
		pi.appendEntry("yokemate-child-state", { version: 1, ownerRunId: runs.ownerRunId, ownerSessionId: runs.ownerSessionId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", sequence: ++childSequence, children: runs.active(), deliveries: [...deliveries.values()].map(({ delivery }) => ({ ...delivery })) });
	};
	pi.on("context", (event) => {
		let changed = false;
		for (const message of event.messages) {
			if (message.role !== "custom" || message.customType !== "subagent-report") continue;
			for (const { delivery, envelope } of deliveries.values()) {
				if (delivery.state === "observed" || message.content !== reportContent(envelope, delivery)) continue;
				const details = message.details as { deliveryId?: string; envelopeHash?: string } | undefined;
				if (details?.deliveryId !== delivery.deliveryId || details.envelopeHash !== delivery.envelopeHash) continue;
				delivery.state = "observed";
				for (const runId of delivery.runIds) {
					const diagnostic = diagnostics.get(runId);
					if (diagnostic) {
						const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
						states[delivery.deliveryId] = { state: delivery.state, envelopeHash: delivery.envelopeHash, observedAt: new Date().toISOString() };
						diagnostic.metadata.deliveries = states;
						diagnostic.save(true);
					}
				}
				changed = true;
			}
		}
		if (changed) emitChildState();
	});
	pi.on("agent_settled", () => emitChildState());
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

			reportBlocked = (reason: string) => {
				if (terminalReported) return;
				terminalReported = true;
				uiAbortByRun.get(ownedRun.identity.runId)?.abort();
				uiAbortByRun.delete(ownedRun.identity.runId);
				const blocked = coordinators.finalize(ownedRun.identity.runId, "blocked", reason);
				releaseCoordinatorUnit(ownedRun.identity.runId);
				const verification = verifyCoordinatorOutcome(root, prepared, { outcome: "blocked", summary: "coordinator stopped", reason }, rpc?.childState.verificationCount("blocked", reason) ?? 1);
				pi.appendEntry("yokemate-coordinator-run", { identity: blocked.identity, state: "blocked", verification, summary: "coordinator stopped", reason });
				pi.sendMessage({ customType: "subagent-report", content: `[coordinator ${blocked.identity.mode} ${blocked.identity.ticket}] blocked: ${reason}`, display: true, details: { runId: blocked.identity.runId, mode: blocked.identity.mode, tickets: blocked.request.tickets, outcome: "blocked", verification } }, { deliverAs: "followUp", triggerTurn: true });
				void rpc?.stop();
				rpcByRun.delete(ownedRun.identity.runId);
			};
			const resolvedModel = resolveCoordinatorModel(prepared.model, ctx.modelRegistry);
			if (resolvedModel.warning) ctx.ui.notify(resolvedModel.warning, "warning");
			if (request.mode === "do") markDoRunning(root, prepared, origin);
			rpc = startCoordinatorRpc(prepared, ownedRun.identity, resolvedModel.expected, { onEvent: (event) => {
				if (rpc && !terminalReported) continueOwnedCoordinator(rpc, event, (reason) => reportBlocked?.(reason));
				if (event.type === "tool_execution_start" && event.toolName === "coordinator_finish" && typeof event.toolCallId === "string") { finishCalls.add(event.toolCallId); return; }
				const result = event.type === "tool_execution_end" ? (event.result as { details?: { kind?: string; runId?: string; outcome?: "done" | "blocked"; summary?: string; reason?: string } } | undefined) : undefined;
				if (event.type !== "tool_execution_end" || event.toolName !== "coordinator_finish" || event.isError || typeof event.toolCallId !== "string" || !finishCalls.delete(event.toolCallId) || result?.details?.kind !== "yokemate-coordinator-outcome" || result.details.runId !== ownedRun.identity.runId || !result.details.outcome || terminalReported) return;
				terminalReported = true;
				const proposal = { outcome: result.details.outcome, summary: result.details.summary ?? "coordinator finished", reason: result.details.reason };
				if (!rpc?.childState.canFinish(proposal.outcome, proposal.reason)) { terminalReported = false; return; }
				const verification = verifyCoordinatorOutcome(root, prepared, proposal, rpc.childState.verificationCount(proposal.outcome, proposal.reason));
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
				cancel: async (runId, _origin) => { const run = coordinators.cancel(runId); await rpcByRun.get(run.identity.runId)?.stop("parent_control_cancel"); rpcByRun.delete(run.identity.runId); },
			}, { root: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), sessionId, runtimeId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", cwd: ctx.cwd, pane: process.env.HERDR_PANE_ID });
		} catch (error) { ctx.ui.notify(`coordinator control is not up: ${(error as Error).message}`, "warning"); }
	});
	pi.registerCommand("yokemate-coordinator-ready", {
		description: "Initialize an owned coordinator RPC runtime.",
		handler: async (args, ctx) => {
			try {
				const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8")) as { identity?: { runId?: string; role?: string; cwd?: string }; prepared?: { cwd?: string; plan?: string; diagnosticRoot?: string } };
				const identity = payload.identity;
				if (!identity || identity.role !== "coordinator" || identity.runId !== process.env.YOKEMATE_RUN_ID || identity.cwd !== ctx.cwd || payload.prepared?.cwd !== ctx.cwd || !ctx.isProjectTrusted()) throw new Error("invalid coordinator ready identity");
				const commands = pi.getCommands().map((command) => command.name);
				if (!commands.includes(`skill:${process.env.YOKEMATE_MODE}-worker`)) throw new Error("worker skill unavailable");
				if (payload.prepared?.plan) {
					try { snapshots = new RunSnapshots(payload.prepared.diagnosticRoot ?? ENGINE_ROOT, payload.prepared.plan); } catch { console.error("[subagent] diagnostic initialization failed"); }
				}
				runs = new ChildRuns(identity.runId!, ctx.sessionManager.getSessionId());
				emitChildState();
				ownedReadyRunId = identity.runId;
				pi.sendMessage({ customType: "yokemate-coordinator-ready", content: "ready", display: false, details: { runId: identity.runId, ok: true } }, { deliverAs: "followUp", triggerTurn: false });
			} catch (error) {
				pi.sendMessage({ customType: "yokemate-coordinator-ready", content: "blocked", display: false, details: { ok: false, reason: (error as Error).message } }, { deliverAs: "followUp", triggerTurn: false });
			}
		},
	});
	pi.registerCommand("yokemate-delivery-error", {
		description: "Record an owned asynchronous report transport error.",
		handler: async (args) => {
			const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8"));
			if (payload.runId !== ownedReadyRunId || !Array.isArray(payload.deliveryIds)) throw new Error("invalid delivery error owner");
			for (const id of payload.deliveryIds) {
				const delivery = deliveries.get(id)?.delivery;
				if (delivery && delivery.state !== "observed" && delivery.state !== "delivery_failed") delivery.state = "delivery_unknown";
			}
			emitChildState();
		},
	});
	pi.registerCommand("yokemate-child-cancel", {
		description: "Record an owned parent cancellation before teardown.",
		handler: async (args) => {
			const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8"));
			if (payload.runId !== ownedReadyRunId || !["parent_rpc_stop", "parent_control_cancel", "parent_cancel_run", "parent_session_shutdown"].includes(payload.reason)) throw new Error("invalid owned child cancellation");
			for (const mark of cancellationByProcess.values()) mark(payload.reason);
		},
	});
	pi.on("session_shutdown", () => {
		controlServer?.close();
		controlServer = undefined;
		controlIdentity = undefined;
		for (const controller of uiAbortByRun.values()) controller.abort();
		uiAbortByRun.clear();
		for (const runId of coordinatorUnits) releaseCoordinatorUnit(runId);
		for (const rpc of rpcByRun.values()) void rpc.stop("parent_session_shutdown");
		rpcByRun.clear();
		for (const proc of detached) {
			cancellationByProcess.get(proc)?.("session_shutdown");
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

	const registerDelivery = (envelope: ReportEnvelope) => {
		const delivery = deliveryFor(envelope);
		if (!deliveries.has(delivery.deliveryId)) deliveries.set(delivery.deliveryId, { delivery, envelope });
		return deliveries.get(delivery.deliveryId)!;
	};
	const sendReport = (envelope: ReportEnvelope): void => {
		const { delivery } = registerDelivery(envelope);
		if (delivery.state !== "pending") return;
		emitChildState();
		try {
			pi.sendMessage({ customType: "subagent-report", content: reportContent(envelope, delivery), display: true, details: { version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope } }, { deliverAs: "followUp", triggerTurn: true });
			if (delivery.state === "pending") delivery.state = "enqueued";
		} catch { delivery.state = "delivery_failed"; }
		for (const runId of delivery.runIds) {
			const diagnostic = diagnostics.get(runId);
			if (diagnostic) {
				const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
				states[delivery.deliveryId] = { state: delivery.state, envelopeHash: delivery.envelopeHash, enqueuedAt: new Date().toISOString() };
				diagnostic.metadata.deliveries = states;
				diagnostic.save(true);
			}
		}
		emitChildState();
	};
	const settleBatch = (batchId: string): void => {
		const batch = runs?.batch(batchId);
		if (!batch || sentBatches.has(batchId)) return;
		sentBatches.add(batchId);
		sendReport(batch);
		batches.delete(batchId);
	};
	const settleResult = (result: ResultEnvelope, report: boolean) => {
		if (!runs?.settle(result)) return;
		if (report) registerDelivery(result);
		const batch = runs.batch(result.identity.batchId);
		if (batch) {
			registerDelivery(batch);
			if (!report) registerDelivery({ ...batch, kind: "chain" });
		}
		if (report) sendReport(result);
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
			if (runs?.active().length || batches.size > 0) return { content: [{ type: "text", text: "coordinator still has active child batches" }], isError: true };
			const pending = [...deliveries.values()].map(({ delivery }) => delivery).filter((delivery) => delivery.state !== "observed");
			if (pending.length && !(params.outcome === "blocked" && pending.some((delivery) => delivery.state === "delivery_failed" || delivery.state === "delivery_unknown") && pending.every((delivery) => params.reason?.includes(delivery.deliveryId)))) return { content: [{ type: "text", text: `coordinator still has pending report delivery: ${pending.map((delivery) => delivery.deliveryId).join(", ")}` }], isError: true };
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
				try { const run = coordinators.cancel(params.cancelRun); uiAbortByRun.get(run.identity.runId)?.abort(); uiAbortByRun.delete(run.identity.runId); void rpcByRun.get(run.identity.runId)?.stop("parent_cancel_run"); rpcByRun.delete(run.identity.runId); return { content: [{ type: "text", text: `${run.identity.runId} cancelled` }] }; }
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

			const ownerRunId = process.env.YOKEMATE_RUN_ID ?? sessionId;
			if (!runs) runs = new ChildRuns(ownerRunId, sessionId);
			if (runs.ownerRunId !== ownerRunId || runs.ownerSessionId !== sessionId) throw new Error("subagent owner changed");
			const runDetachedAgent = async (mode: "single" | "parallel" | "chain", identity: ChildIdentity, task: string, step?: number): Promise<{ envelope: ResultEnvelope; output: string }> => {
				let child: ChildProcess | undefined;
				let envelope: ResultEnvelope;
				let output = "";
				try {
					if (shuttingDown) return { envelope: resultEnvelope(identity, task, { processOutcome: "not_started", exitCode: null, signal: null }, ""), output };
					runs!.start(identity);
					emitChildState();
					const result = await runSingleAgent(ctx.cwd, dispatchDefaults, agents, identity.agent, task, identity.cwd, step, undefined, undefined, makeDetails(mode), (proc) => {
						child = proc;
						detached.add(proc);
						trackRunning(proc, identity.agent, task);
					}, identity, diagnostics.get(identity.runId)!);
					output = getFinalOutput(result.messages);
					envelope = result.envelope ?? resultEnvelope(identity, task, { processOutcome: "not_started", exitCode: null, signal: null }, "");
				} catch (error) {
					const diagnostic = diagnostics.get(identity.runId);
					if (diagnostic) { diagnostic.metadata.spawnError = errorMetadata(error); diagnostic.save(true); }
					envelope = resultEnvelope(identity, task, { processOutcome: "spawn_error", exitCode: null, signal: null }, "");
				} finally {
					if (child) detached.delete(child);
					untrackRunning(child);
				}
				return { envelope, output };
			};
			const launch = (mode: "single" | "parallel" | "chain", tasks: { agent: string; task: string; cwd?: string; review?: { baseSha: string; headSha: string } }[]) => {
				const units = mode === "chain" ? 1 : tasks.length;
				const admission = subagentAdmission(policy, limits, mode, units, activeUnits);
				if (admission) throw new Error(admission);
				const ack = runs!.admit(toolCallId, tasks, ctx.cwd);
				for (const { identity } of ack.children) {
					const metadata: Record<string, unknown> = { identity, admissionAt: new Date().toISOString(), extension: fileProvenance(new URL(import.meta.url).pathname), guard: fileProvenance(path.join(root, "src/guards.ts")), taskHash: identity.taskHash, cancellationInitiator: "unknown", deliveries: {} };
					const diagnostic = { metadata, save: (completed: boolean) => { snapshots?.write(identity.ownerRunId, identity.runId, metadata, completed); } };
					diagnostics.set(identity.runId, diagnostic);
					diagnostic.save(false);
				}
				activeUnits += units;
				batches.add(toolCallId);
				emitChildState();
				const execute = async () => {
					try {
						if (mode === "chain") {
							let previous = "";
							let failed = false;
							for (let i = 0; i < tasks.length; i++) {
								const identity = ack.children[i]!.identity;
								const task = tasks[i]!.task.replace(/\{previous\}/g, previous);
								const { envelope: result, output } = failed ? { envelope: resultEnvelope(identity, task, { processOutcome: "not_started", exitCode: null, signal: null }, ""), output: "" } : await runDetachedAgent(mode, identity, task, i + 1);
								settleResult(result, false);
								failed ||= failedEnvelope(result);
								previous = output;
							}
							sendReport(runs!.batch(toolCallId, "chain")!);
						} else {
							await mapWithConcurrencyLimit(tasks, subagentConcurrency(policy, limits, tasks.length), async (task, i) => {
								const { envelope: result } = await runDetachedAgent(mode, ack.children[i]!.identity, task.task);
								settleResult(result, true);
							});
						}
						settleBatch(toolCallId);
					} finally { activeUnits -= units; }
				};
				void execute().catch(() => console.error("[subagent] detached dispatch failed"));
				return { content: [{ type: "text", text: `Detached, not terminal: ${JSON.stringify(ack)}` }], details: { ...makeDetails(mode)([]), ...ack } };
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

			if (params.chain?.length) return launch("chain", params.chain);
			if (params.tasks?.length) return launch("parallel", params.tasks);
			if (params.agent && params.task) return launch("single", [{ agent: params.agent, task: params.task, cwd: params.cwd, review: params.review }]);

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
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
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
						const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
					const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
