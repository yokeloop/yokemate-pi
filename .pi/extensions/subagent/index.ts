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

import { DatabaseSync } from "node:sqlite";
import { readCandidatePlanSnapshot, readRecordedPlanBinding, readWorkflowBindingSnapshot, assertPlanBinding, toPlanBinding, readPlanWriterSnapshot, reconcilePlanWriterArtifact, resolvePlanWriterScope, PlanWriterArtifactError, type PlanBinding, type PlanWriterScope } from "../../../src/plan-binding.ts";
import { DoAuthorityStore, isWorkflowCandidate, PendingWorkflowExtraction, validateExtraction, WORKFLOW_EXTRACTION_INSTRUCTION, type ApprovalParent, type InputGeneration, type WorkflowCancellationReason, type WorkflowExtractionTerminal } from "../../../src/workflow-approval.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { boundBatchResult, cancellationResult, type CancellationResult, deliveryFor, reportContent, type ReportDelivery, type ReportEnvelope, RunSnapshots, errorMetadata, fileProvenance, JsonlObservation, ChildRuns, resultEnvelope, failedEnvelope, matchingObservedReview, sha256, type ChildIdentity, type ResultEnvelope, type BatchEnvelope, type LaunchAck } from "../../../src/subagent-runs.ts";
import { captureScoutCandidate } from "../../../src/plan-scout-recovery.ts";
import { appendIncidentEvent, appendRecoveryAttempt, appendRecoveryDecision, claimWriterDispatch, incidentById, persistScoutCandidate, recordWriterDraft, writerDraftFor, WriterDraftConflictError } from "../../../src/workflow-incident-state.ts";
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
import { type Component, Container, getKeybindings, Markdown, Spacer, Text, TruncatedText, visibleWidth } from "@earendil-works/pi-tui";
import { buildCoordinatorDisplay, buildReportDisplay, reportTaskExcerpt, subagentReportRenderer, type ReportAdmissionDisplay, type ReportDiagnosticFacts, type SubagentReportDisplayV1 } from "../../../src/subagent-report.ts";
import { coordinatorArtifactId, SubagentReportStore } from "../../../src/subagent-report-store.ts";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { markDoRunning, prepareDo, prepareShip, splitDoRequest, validateCoordinatorRequest, type CoordinatorRequest } from "../../../src/coordinator-launch.ts";
import { CoordinatorRegistry, ShipPermitStore, coordinatorChecks, type CoordinatorRun } from "../../../src/coordinator-runtime.ts";
import { composeWidgetParts, taskExcerpt, widgetParts } from "../../../src/subagent-widget.ts";
import { continueOwnedCoordinator, startCoordinatorRpc } from "../../../src/coordinator-rpc.ts";
import { resolveCoordinatorModel } from "../../../src/coordinator-model.ts";
import { verifyCoordinatorOutcome, verifyPreparedShipMerged } from "../../../src/coordinator-result.ts";
import { type PlanCompletionContext, currentControlOrigin, requestPlanControl, requestReviewControl, bindCoordinatorControl, processStarttime, requestCoordinator, requestCoordinatorCancel, PlanRecorderFences, requestCoordinatorMerge, requestShipFinalize, resolveCoordinatorParent } from "../../../src/coordinator-control.ts";
import { showCoordinatorEditor } from "../../../src/coordinator-ui.ts";
import { researchChildLaunch, researchIdentity } from "../../../src/research-guard.ts";
import { ENGINE_ROOT, readRuntimeSettings, type RuntimeSettings, subagentAdmission, subagentConcurrency } from "../../../src/guard-policy.ts";
import { ListRunRegistry, type KeyRunContext } from "../../../src/list-run.ts";
import { launchPlanKey } from "../../../src/plan-launch.ts";
import { herdrAsync } from "../../../src/herdr.ts";
import { closeModeSurface } from "../../../src/mode-surface.ts";
import { observeProcessIdentity, ReviewReworkStore, REVIEW_REWORK_EXTRACTION_INSTRUCTION, adaptReviewReworkQuotes, validateReviewReworkExtraction, type ReviewHandoffOutcome } from "../../../src/review-rework.ts";
import { recordReviewRework } from "../../../src/accept.ts";
import { logMove } from "../../../src/move-log.ts";
import { syncPush } from "../../../src/git-sync.ts";
import { openDb } from "../../../src/db.ts";
import { dataRoot } from "../../../src/data-root.ts";
import { modelForTicket } from "../../../src/project-model.ts";
import { poolModel } from "../../../src/pool.ts";
import { recordPlan as recordPlanFile, type PlanRecordResult } from "../../../src/plan-record.ts";
import { coordinatorMerge, type CoordinatorMergeRequest } from "../../../src/coordinator-merge.ts";
import { finalizeShip } from "../../../src/ship-finalize.ts";
import { PublicationTargetFailure, publicationTargetLabel, resolvePublicationTarget } from "../../../src/plan-publication-target.ts";
import { acceptPlanRecord, acceptPublication, acceptPublicationDelivery, acceptRecoveredPublication, acceptScoutArtifact, markPublicationResult, planRecordById, publicationAcceptanceById, publicationById, readPublicationArtifact, recordPublicationBlock, revokePendingPlanRecords, reserveCanonicalUrl, writePublicationArtifact, type ArtifactMetadata, type PublicationError, type PublicationOutcome, type PublicationProvenance, type PublicationRow } from "../../../src/plan-publication-state.ts";
import { assertPublishable, normalizeScoutMarkdown, publishDocument, PublicationFailure } from "../../../src/plan-publication.ts";
import { PlanPublicationMcp } from "../../../src/plan-publication-mcp.ts";
import { githubPublicationAdapter } from "../../../src/github.ts";
import { installWorkflowIngress, WorkflowIngressWitnessStore, type WorkflowIngressWitness } from "../../../src/workflow-ingress.ts";
import { BreakGlassPermitStore, parseBreakGlass, previewScoutAcceptance, resolveScoutAcceptance, type BreakGlassPreview, type PlanSnapshotIdentity } from "../../../src/workflow-break-glass.ts";
import { assertMandatoryBoundary } from "../../../src/workflow-boundaries.ts";

const COLLAPSED_ITEM_COUNT = 10;

// Отвязанные дети живут дольше своего тул-колла: AbortSignal тула у них уже
// нет, и убить их некому, кроме конца сессии.
const detached = new Set<ChildProcess>();
interface OrdinaryProcess {
	identity: ChildIdentity;
	process: ChildProcess;
	pid: number;
	starttime: string;
	closed: boolean;
	termSent: boolean;
	killSent: boolean;
	killTimer?: NodeJS.Timeout;
}
const ordinaryProcesses = new Map<string, OrdinaryProcess>();
let requestOrdinaryCancellation: (runId: string, initiator: string, ownerRunId: string, ownerSessionId: string) => Promise<CancellationResult> = async (runId) => cancellationResult(runId, "unknown", "unknown", false);
// Ребёнок попадает в реестр только после await внутри runSingleAgent, а пачка
// тул-коллов одного хода исполняется в один тик — по одному лишь размеру
// реестра все они прошли бы потолок. Единица работы считается сразу, синхронно
// в execute, и снимается со счёта своим settle.
let activeUnits = 0;
// Уборка на session_shutdown видит только уже поднятых детей. Очередь батча
// (задачи сверх maxConcurrency) и следующий шаг цепочки поднимаются позже — в
// те миллисекунды, что pi ещё дочитывает ввод, — и осиротели бы. Флаг
// закрывает очередь; turn_start снимает его, если сессия вернулась.
// Батч закрывает расширение: сколько поднято и сколько осело, знает только
// оно. Счёт, отданный модели, врёт молча — таб уйдёт дальше на неполном наборе.
const batches = new Set<string>();
const batchModes = new Map<string, "single" | "parallel" | "chain">();

// Отвязанный вызов сворачивает тул-колл, и в ленте не остаётся ничего живого:
// кто сейчас работает, видно только отсюда — строкой над редактором.
const runningAgents = new Map<ChildProcess, { name: string; task: string; startedAt: number }>();
const rpcByRun = new Map<string, ReturnType<typeof startCoordinatorRpc>>();
const coordinatorChildren = new Map<string, string[]>();
let widgetTimer: NodeJS.Timeout | undefined;
// ctx протухает вместе с сессией, поэтому рисуем всегда по свежему: тому, что
// пришёл в execute текущего вызова или в turn_start, а не захваченному.
let latestCtx: ExtensionContext | undefined;
const scoutCandidateIds = new Map<string, string>();
const scoutCandidateGenerations = new Map<string, number>();
const verifiedWriterDrafts = new Map<string, { acceptedInputId: number; planningIdentity: string; runId: string }>();
const planWriterScopes = new Map<string, PlanWriterScope>();

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
		const lines = widgetParts(runningAgents.values(), Date.now());
		const running = Array.from(runningAgents.keys(), (proc, i) => [proc, lines[i]!] as const);
		const childrenByProcess = new Map<ChildProcess, string[]>();
		for (const [runId, rpc] of rpcByRun) {
			const children = coordinatorChildren.get(runId);
			if (children) childrenByProcess.set(rpc.process, children);
		}
		const parts = composeWidgetParts(running, childrenByProcess);
		if (latestCtx.mode === "tui") latestCtx.ui.setWidget("subagent-running", () => new RunningAgentsWidget(parts));
		else latestCtx.ui.setWidget("subagent-running", parts);
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
	for (const [runId, rpc] of rpcByRun) {
		if (rpc.process === proc) coordinatorChildren.delete(runId);
	}
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
	cleanupError?: string;
	cleanupPath?: string;
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

class PromptCleanupFailure extends Error {
	readonly dir: string;
	readonly writeFailure: ReturnType<typeof errorMetadata>;
	readonly cleanupFailure: ReturnType<typeof errorMetadata>;
	constructor(dir: string, writeError: unknown, cleanupError: unknown) {
		super("temporary prompt write and cleanup failed");
		this.dir = dir;
		this.writeFailure = errorMetadata(writeError);
		this.cleanupFailure = errorMetadata(cleanupError);
	}
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
		return { dir: tmpDir, filePath };
	} catch (error) {
		try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); }
		catch (cleanupError) { throw new PromptCleanupFailure(tmpDir, error, cleanupError); }
		throw error;
	}
}

let pinnedPiCli: string | undefined;
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	if (!pinnedPiCli) {
		const packageRoot = fs.realpathSync(path.join(ENGINE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
		const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		if (manifest.version !== "0.85.1") throw new Error("pinned Pi 0.85.1 is unavailable");
		const contract = fs.readFileSync(path.join(packageRoot, "dist", "modes", "json-event.js"), "utf8");
		if (!contract.includes("YOKEMATE_SUBAGENT_JSON_CONTRACT_VERSION = 1")) throw new Error("pinned Pi JSON contract patch is unavailable");
		pinnedPiCli = fs.realpathSync(path.join(packageRoot, "dist", "cli.js"));
	}
	const relay = process.env.YOKEMATE_SUBAGENT_TEST_RELAY;
	if (relay && process.env.NODE_TEST_CONTEXT) {
		const canonicalRelay = fs.realpathSync(relay);
		const fixtureRoot = fs.realpathSync(path.join(ENGINE_ROOT, "test", "fixtures"));
		if (path.dirname(canonicalRelay) !== fixtureRoot || path.basename(canonicalRelay) !== "subagent-json-relay.mjs") throw new Error("invalid test JSON relay");
		return { command: process.execPath, args: [canonicalRelay, pinnedPiCli, ...args] };
	}
	return { command: process.execPath, args: [pinnedPiCli, ...args] };
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
	lifecycle: ChildRuns,
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
	const args: string[] = ["--mode", "json", "-p", ...(coordinatorChild ? process.env.PI_CODING_AGENT_SESSION_DIR ? [] : ["--session-dir", path.join(process.cwd(), "sessions")] : ["--no-session"]), "--extension", path.join(ENGINE_ROOT, "src", "guards.ts")];
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
		if (!lifecycle.canSpawn(identity)) {
			currentResult.envelope = lifecycle.claimNoSpawn(identity);
			return currentResult;
		}
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			if (!lifecycle.canSpawn(identity)) {
				currentResult.envelope = lifecycle.claimNoSpawn(identity);
				return currentResult;
			}
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
		const refreshObservation = (stream = observation.metadata()) => {
			diagnostic.metadata.stream = stream;
			diagnostic.metadata.stderr = { class: stderrBytes === 0 ? "none" : "unknown", bytes: stderrBytes, hash: stderrHash.copy().digest("hex") };
			diagnostic.metadata.sessionId = observation.sessionId;
			diagnostic.metadata.effective = { model: observation.model ?? "unknown", provider: observation.provider ?? "unknown", thinking: "unknown" };
		};
		let lastProgressSnapshot = 0;
		let priorParserErrors = 0;
		let priorPhase: string = "unknown";
		const checkpointProgress = () => {
			const stream = observation.metadata();
			const now = Date.now();
			const firstFault = priorParserErrors === 0 && stream.parserErrors > 0;
			const phaseChanged = stream.phase !== priorPhase;
			priorParserErrors = stream.parserErrors;
			priorPhase = stream.phase;
			if (!firstFault && !phaseChanged && now - lastProgressSnapshot < 1000) return;
			lastProgressSnapshot = now;
			refreshObservation(stream);
			diagnostic.save(false);
		};
		if (!lifecycle.canSpawn(identity)) {
			currentResult.envelope = lifecycle.claimNoSpawn(identity);
			return currentResult;
		}
		const terminal = await new Promise<{ exitCode: number | null; signal: string | null; processOutcome: "exited" | "signaled" | "spawn_error" }>((resolve) => {
			const invocation = getPiInvocation(args);
			const child = research ? researchChildLaunch(research, identity.cwd, [research.root, ...(research.projectPath ? [research.projectPath] : [])]) : undefined;
			const env: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_ROLE: "executor", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_RUN_ID: identity.ownerRunId, YOKEMATE_SUBAGENT_JSON_CONTRACT: "1", ...(child?.env ?? {}) };
			delete env.HERDR_PANE_ID;
			delete env.YOKEMATE_PARENT_PANE;
			let spawnError: Error | undefined;
			const proc = spawn(invocation.command, invocation.args, { cwd: child?.cwd ?? identity.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			const starttime = proc.pid ? processStarttime(proc.pid) : undefined;
			diagnostic.metadata.pid = proc.pid;
			diagnostic.metadata.starttime = starttime;
			diagnostic.metadata.spawnAt = new Date().toISOString();
			if (proc.pid && starttime && lifecycle.attachProcess(identity, proc.pid, starttime)) ordinaryProcesses.set(identity.runId, { identity, process: proc, pid: proc.pid, starttime, closed: false, termSent: false, killSent: false });
			diagnostic.save(false);
			onSpawn?.(proc);
			const abort = () => { void requestOrdinaryCancellation(identity.runId, "tool_abort_signal", identity.ownerRunId, identity.ownerSessionId); };
			proc.stdout.on("data", (data: Buffer) => { observation.write(data); checkpointProgress(); });
			proc.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; stderrHash.update(data); currentResult.stderr = "child stderr observed"; });
			proc.on("error", (error) => { spawnError = error; diagnostic.metadata.spawnError = errorMetadata(error); });
			proc.once("close", (exitCode, signalName) => {
				const owned = ordinaryProcesses.get(identity.runId);
				if (owned) {
					owned.closed = true;
					clearTimeout(owned.killTimer);
				}
				signal?.removeEventListener("abort", abort);
				observation.end();
				diagnostic.metadata.closeAt = new Date().toISOString();
				const processOutcome = spawnError ? "spawn_error" : signalName ? "signaled" : "exited";
				lifecycle.claimTerminal(identity, task, { exitCode, signal: signalName, processOutcome, stopReason: observation.stopReason, protocolError: observation.protocolError, incomplete: observation.incomplete, diagnostics: { stream: observation.metadata(), stderr: { class: stderrBytes === 0 ? "none" : "unknown", bytes: stderrBytes, hash: stderrHash.copy().digest("hex") }, final: { bytes: 0, hash: sha256(""), previewBytes: 0, previewHash: sha256(""), truncated: false } } }, observation.finalText);
				resolve({ exitCode, signal: signalName, processOutcome });
			});
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
		currentResult.exitCode = terminal.exitCode;
		refreshObservation();
		const stream = observation.metadata();
		const stderr = { class: stderrBytes === 0 ? "none" as const : "unknown" as const, bytes: stderrBytes, hash: stderrHash.copy().digest("hex") };
		currentResult.envelope = lifecycle.claimed(identity) ?? resultEnvelope(identity, task, { ...terminal, stopReason: observation.stopReason, protocolError: observation.protocolError, incomplete: observation.incomplete, diagnostics: { stream, stderr, final: { bytes: 0, hash: sha256(""), previewBytes: 0, previewHash: sha256(""), truncated: false } } }, observation.finalText);
		if (identity.agent === "plan-scout" && identity.ticket && currentResult.envelope.payloadOutcome === "protocol_error" && currentResult.envelope.processOutcome !== "cancelled" && process.env.YOKEMATE_MODE === "plan" && process.env.YOKEMATE_PLAN_RUN_ID) {
			try {
				const parent = resolveCoordinatorParent(ENGINE_ROOT);
				const planningIdentity = process.env.YOKEMATE_PLAN_RUN_ID;
				const generation = (scoutCandidateGenerations.get(planningIdentity) ?? 0) + 1;
				scoutCandidateGenerations.set(planningIdentity, generation);
				const captured = captureScoutCandidate({ root: ENGINE_ROOT, identity, envelope: currentResult.envelope, finalText: observation.finalText, childSessionId: observation.sessionId, evidence: observation.evidence(), planningIdentity, generation, parentRuntimeId: parent.runtimeId, parentSessionId: parent.sessionId });
				if (captured.state === "captured") {
					const state = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
					let candidateId: string;
					try { candidateId = persistScoutCandidate(state, ENGINE_ROOT, captured.candidate).id; }
					finally { state.close(); }
					const registration = await requestPlanControl(ENGINE_ROOT, "register-scout-candidate", { ticket: identity.ticket, runId: planningIdentity, candidateId, failureHash: captured.candidate.failedEnvelopeHash, generation }, currentControlOrigin(ENGINE_ROOT, identity.ownerSessionId), parent);
					if (registration.state !== "accepted") throw new Error(registration.reason ?? "candidate lineage registration refused");
					scoutCandidateIds.set(identity.runId, candidateId);
					currentResult.envelope.recovery = { sourceTransport: "failed", state: "candidate", candidateId, failureHash: captured.candidate.failedEnvelopeHash, payloadHash: captured.candidate.contentHash, bytes: captured.candidate.bytes };
					diagnostic.metadata.scoutCandidate = { id: candidateId, hash: captured.candidate.contentHash, bytes: captured.candidate.bytes, failureHash: captured.candidate.failedEnvelopeHash };
				} else diagnostic.metadata.scoutCandidate = { refusal: captured.reason };
			} catch (error) { diagnostic.metadata.scoutCandidate = { refusal: "audit-unavailable", error: errorMetadata(error) }; }
		}
		if (identity.agent === "plan-scout" && identity.ticket && currentResult.envelope.payloadOutcome === "valid" && currentResult.envelope.processOutcome !== "cancelled") {
			const bytes = normalizeScoutMarkdown(observation.finalText);
			try {
				assertPublishable(bytes);
				const hash = sha256(bytes);
				const artifact = writePublicationArtifact(ENGINE_ROOT, identity.ticket, "scout", hash, bytes);
				currentResult.envelope.artifact = { state: "verified", path: artifact, hash, bytes: bytes.length };
			} catch (error) {
				const code = error instanceof PublicationFailure ? error.code : "artifact_invalid";
				currentResult.envelope.artifact = { state: "blocked", hash: sha256(bytes), bytes: bytes.length, reason: code };
			}
		}
		refreshObservation();
		diagnostic.metadata.terminal = { processOutcome: currentResult.envelope.processOutcome, exitCode: currentResult.envelope.exitCode, signal: currentResult.envelope.signal, stopReason: observation.stopReason };
		diagnostic.metadata.actualTaskHash = currentResult.envelope.actualTaskHash;
		diagnostic.metadata.usage = { ...currentResult.usage };
		diagnostic.metadata.payload = { outcome: currentResult.envelope.payloadOutcome, bytes: Buffer.byteLength(observation.finalText), hash: sha256(observation.finalText), retainedBytes: Buffer.byteLength(currentResult.envelope.payload), retainedHash: sha256(currentResult.envelope.payload), truncated: currentResult.envelope.payload !== observation.finalText, verdict: currentResult.envelope.reviewVerdict };
		diagnostic.metadata.artifact = currentResult.envelope.artifact;
		diagnostic.save(true);
		const snapshotStorage = diagnostic.metadata.snapshotStorage as { state: "available" | "unavailable"; code?: string } | undefined;
		if (snapshotStorage && currentResult.envelope.diagnostics) currentResult.envelope.diagnostics.snapshotStorage = { ...snapshotStorage };
		return currentResult;
	} finally {
		if (tmpPromptDir) {
			try { fs.rmSync(tmpPromptDir, { recursive: true, force: true }); }
			catch (error) {
				currentResult.cleanupError = "temporary prompt cleanup could not be verified";
				currentResult.cleanupPath = tmpPromptDir;
				diagnostic.metadata.cleanupError = { reason: currentResult.cleanupError, path: tmpPromptDir, cleanupFailure: errorMetadata(error) };
				diagnostic.save(true);
			}
		}
	}
}

const ReviewRevisionSchema = Type.Object({ baseSha: Type.String(), headSha: Type.String() });

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	ticket: Type.Optional(Type.String({ description: "Explicit ticket binding for a plan scout" })),
	review: Type.Optional(ReviewRevisionSchema),
	acceptedInputId: Type.Optional(Type.Integer({ minimum: 1, description: "Accepted scout input binding for a plan writer" })),
	writerRevisionOf: Type.Optional(Type.String({ description: "Verified prior plan draft hash for an explicit revision" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	ticket: Type.Optional(Type.String({ description: "Explicit ticket binding for a plan scout" })),
	review: Type.Optional(ReviewRevisionSchema),
	acceptedInputId: Type.Optional(Type.Integer({ minimum: 1, description: "Accepted scout input binding for a plan writer" })),
	writerRevisionOf: Type.Optional(Type.String({ description: "Verified prior plan draft hash for an explicit revision" })),
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
	acceptedInputId: Type.Optional(Type.Integer({ minimum: 1, description: "Accepted scout input binding for a plan writer" })),
	writerRevisionOf: Type.Optional(Type.String({ description: "Verified prior plan draft hash for an explicit revision" })),
	coordinator: Type.Optional(CoordinatorRequestSchema),
	cancelRun: Type.Optional(Type.String({ description: "Exact ordinary ACK, coordinator, list, or list-key run UUID to cancel", pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$" })),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	ticket: Type.Optional(Type.String({ description: "Explicit ticket binding for a plan scout" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("subagent-report", subagentReportRenderer);
	const reportStore = new SubagentReportStore(path.join(ENGINE_ROOT, ".pi", "subagent-reports"));
	let runs: ChildRuns | undefined;
	let shuttingDown = false;
	let sessionGeneration = 0;
	interface OwnedGeneration {
		serial: number;
		ownerRunId: string;
		ownerSessionId: string;
		runs: ChildRuns;
		fenced: boolean;
		producerObligations: number;
		batchDispatches: number;
		failureProduced: number;
		failureConsumed: number;
		revision: number;
		listeners: Set<() => void>;
	}
	let ownedGeneration: OwnedGeneration | undefined;
	const ownedGenerations = new Map<string, OwnedGeneration>();
	const ownedGenerationKey = (ownerRunId: string, ownerSessionId: string): string => `${ownerRunId}\0${ownerSessionId}`;
	const batchCompletions = new Map<string, { promise: Promise<void>; resolve(): void }>();
	let nextScoutSequence = 0;
	const scoutSequenceByRunId = new Map<string, number>();
	const publicationMcp = new PlanPublicationMcp(pi, ENGINE_ROOT);
	const publicationTail = new Map<string, Promise<unknown>>();
	const localPublicationErrors = new Set<PublicationError>(["artifact_invalid", "unsafe_document", "binding_changed"]);
	const targetFailureCode = (error: unknown): PublicationError => error instanceof PublicationTargetFailure ? error.code : "target_unavailable";
	const safeTarget = (ticket: string): string => {
		const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		try { return publicationTargetLabel(db, ticket); }
		finally { db.close(); }
	};
	const publishAccepted = async (publicationId: number, verifyBinding?: () => void | Promise<void>) => {
		const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		let publication: PublicationRow;
		let bytes: Buffer;
		try {
			const row = publicationById(db, publicationId);
			if (!row) throw new PublicationFailure("artifact_invalid");
			publication = row;
			bytes = readPublicationArtifact(ENGINE_ROOT, row);
			assertPublishable(bytes);
		} finally { db.close(); }
		const key = `${publication.target}\u0000${publication.ticket}`;
		const prior = publicationTail.get(key) ?? Promise.resolve();
		const work = prior.catch(() => undefined).then(async () => {
			let canonicalUrl: string | undefined = publication.canonical_url ?? undefined;
			let target: ReturnType<typeof resolvePublicationTarget>;
			const verifyPublicationBinding = async () => {
				const binding = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				try {
					try { target = resolvePublicationTarget(binding, publication.ticket); }
					catch (error) { throw new PublicationFailure(targetFailureCode(error)); }
					if (target.target !== publication.target || target.targetHash !== publication.target_hash) throw new PublicationFailure("target_changed");
					try {
						const current = readPublicationArtifact(ENGINE_ROOT, publication);
						assertPublishable(current);
					} catch (error) {
						if (error instanceof PublicationFailure) throw error;
						throw new PublicationFailure("artifact_invalid");
					}
				} finally { binding.close(); }
				await verifyBinding?.();
			};
			try {
				await verifyPublicationBinding();
				const resolved = target!.type === "github"
					? { adapter: githubPublicationAdapter(target!), canonicalUrl: target!.canonicalUrl }
					: await publicationMcp.youTrackAdapter(target!.server, target!.issueId);
				const binding = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				try {
					if (!reserveCanonicalUrl(binding, publication.id, resolved.canonicalUrl)) throw new PublicationFailure("remote_conflict");
					publication = publicationById(binding, publication.id)!;
				} finally { binding.close(); }
				canonicalUrl = resolved.canonicalUrl;
				if (publication.source_kind === "engineer-accepted-input") {
					const audit = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
					try {
						const incident = publication.incident_id ? incidentById(audit, publication.incident_id) : undefined;
						if (!incident) throw new PublicationFailure("artifact_invalid");
						appendIncidentEvent(audit, incident, { kind: "effect-start", code: `publish-${publication.kind}`, payloadHash: publication.payload_hash ?? undefined, failureHash: publication.failure_hash ?? undefined, planHash: publication.kind === "plan" ? publication.content_hash : undefined, effect: `publish-${publication.kind}`, outcome: "started" });
					} finally { audit.close(); }
				}
				const knowledgePath = publication.plan_path ? path.relative(ENGINE_ROOT, publication.plan_path) : undefined;
				const result = await publishDocument(publication, bytes, resolved.adapter, { canonicalUrl: resolved.canonicalUrl, knowledgePath, verifyBinding: verifyPublicationBinding });
				const update = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				try {
					update.exec("BEGIN IMMEDIATE");
					markPublicationResult(update, publication.id, { complete: result.complete, error: result.error, canonicalUrl: resolved.canonicalUrl });
					if (publication.source_kind === "engineer-accepted-input") {
						const incident = publication.incident_id ? incidentById(update, publication.incident_id) : undefined;
						if (!incident) throw new PublicationFailure("artifact_invalid");
						appendIncidentEvent(update, incident, { kind: "outcome", code: result.error ?? (result.complete ? "complete" : "partial"), payloadHash: publication.payload_hash ?? undefined, failureHash: publication.failure_hash ?? undefined, planHash: publication.kind === "plan" ? publication.content_hash : undefined, effect: `publish-${publication.kind}`, outcome: result.complete ? "complete" : "partial" });
					}
					update.exec("COMMIT");
				} catch (error) { try { update.exec("ROLLBACK"); } catch {} throw error; }
				finally { update.close(); }
				return { ...result, target: resolved.canonicalUrl };
			} catch (error) {
				const code = error instanceof PublicationFailure ? error.code : "unavailable";
				if (localPublicationErrors.has(code)) throw error;
				const update = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				try {
					update.exec("BEGIN IMMEDIATE");
					markPublicationResult(update, publication.id, { complete: false, error: code, canonicalUrl });
					if (publication.source_kind === "engineer-accepted-input") {
						const incident = publication.incident_id ? incidentById(update, publication.incident_id) : undefined;
						if (!incident) throw new PublicationFailure("artifact_invalid");
						appendIncidentEvent(update, incident, { kind: "outcome", code, payloadHash: publication.payload_hash ?? undefined, failureHash: publication.failure_hash ?? undefined, planHash: publication.kind === "plan" ? publication.content_hash : undefined, effect: `publish-${publication.kind}`, outcome: "failed" });
					}
					update.exec("COMMIT");
				} catch (auditError) { try { update.exec("ROLLBACK"); } catch {} throw auditError; }
				finally { update.close(); }
				return { complete: false, error: code, parts: 0, revision: publication.content_hash, target: canonicalUrl ?? safeTarget(publication.ticket) };
			}
		});
		publicationTail.set(key, work);
		try { return await work; }
		finally { if (publicationTail.get(key) === work) publicationTail.delete(key); }
	};
	const attemptArtifactPublication = async (input: {
		kind: "scout" | "plan"; ticket: string; artifact: ArtifactMetadata; runId: string; publicationId?: number;
		child?: ChildIdentity; planPath?: string; scopeHash?: string; attach(db: DatabaseSync, row: PublicationRow): void;
		verifyBinding?: () => void | Promise<void>; provenance?: PublicationProvenance; acceptanceId?: number;
	}): Promise<PublicationOutcome> => {
		const local = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		let row: PublicationRow | undefined;
		try {
			const bytes = readPublicationArtifact(ENGINE_ROOT, input.artifact);
			assertPublishable(bytes);
			if (input.publicationId !== undefined) {
				row = publicationById(local, input.publicationId);
				if (!row || row.ticket !== input.ticket || row.kind !== input.kind || row.content_hash !== input.artifact.content_hash || row.artifact_path !== input.artifact.artifact_path || row.bytes !== input.artifact.bytes) throw new PublicationFailure("artifact_invalid");
			}
			let target;
			try { target = resolvePublicationTarget(local, input.ticket); }
			catch (error) {
				const code = targetFailureCode(error);
				if (row) markPublicationResult(local, row.id, { complete: false, error: code });
				return { kind: input.kind, state: "pending", target: row?.canonical_url ?? publicationTargetLabel(local, input.ticket), revision: input.artifact.content_hash, ...(row ? { publicationId: row.id } : {}), error: code };
			}
			if (row && (row.target !== target.target || row.target_hash !== target.targetHash)) {
				markPublicationResult(local, row.id, { complete: false, error: "target_changed" });
				return { kind: input.kind, state: "pending", target: row.canonical_url ?? publicationTargetLabel(local, input.ticket), revision: row.content_hash, publicationId: row.id, error: "target_changed" };
			}
			if (!row) {
				const identity = { target: target.target, targetHash: target.targetHash, ticket: input.ticket, kind: input.kind, bytes, runId: input.runId, child: input.child, planPath: input.planPath, scopeHash: input.scopeHash };
				row = input.provenance?.source_kind === "engineer-accepted-input" ? acceptRecoveredPublication(local, ENGINE_ROOT, identity, input.acceptanceId!) : acceptPublication(local, ENGINE_ROOT, identity);
			}
			input.attach(local, row);
		} finally { local.close(); }
		const result = await publishAccepted(row!.id, input.verifyBinding);
		return { kind: input.kind, state: result.complete ? "complete" : "pending", target: result.target, revision: result.revision, publicationId: row!.id, ...(result.error ? { error: result.error } : {}) };
	};
	const snapshots = new RunSnapshots(ENGINE_ROOT);
	const diagnostics = new Map<string, { metadata: Record<string, unknown>; save(completed: boolean): void }>();
	const reportAdmissions = new Map<string, ReportAdmissionDisplay>();
	const reportSettledAt = new Map<string, number>();
	const reportDisplays = new Map<string, SubagentReportDisplayV1>();
	const reportArchives = new Map<string, { facts: Record<string, unknown> }>();
	const coordinatorAdmissions = new Map<string, { startedAt: number; taskExcerpt: string }>();
	const sentBatches = new Set<string>();
	const settlingRuns = new Set<string>();
	const deliveries = new Map<string, { delivery: ReportDelivery; envelope: ReportEnvelope; generation?: OwnedGeneration }>();
	const wakeOwnedGeneration = (generation: OwnedGeneration, failure = false): void => {
		if (failure) generation.failureProduced += 1;
		generation.revision += 1;
		for (const listener of [...generation.listeners]) listener();
	};
	const currentOwnedGeneration = (): OwnedGeneration | undefined => {
		const generation = ownedGeneration;
		if (!generation || generation.fenced || shuttingDown || ownedReadyRunId !== generation.ownerRunId || process.env.YOKEMATE_ROLE !== "coordinator" || process.env.YOKEMATE_RUN_ID !== generation.ownerRunId || runs !== generation.runs || runs.ownerSessionId !== generation.ownerSessionId) return;
		return generation;
	};
	const ownedGenerationFor = (envelope: ReportEnvelope): OwnedGeneration | undefined => {
		const identities = envelope.kind === "result" ? [envelope.identity] : envelope.results.map((result) => result.identity);
		const ownerRunId = identities[0]?.ownerRunId;
		const ownerSessionId = identities[0]?.ownerSessionId;
		const generation = ownerRunId && ownerSessionId ? ownedGenerations.get(ownedGenerationKey(ownerRunId, ownerSessionId)) : undefined;
		if (!generation || !identities.length || identities.some((identity) => identity.ownerRunId !== generation.ownerRunId || identity.ownerSessionId !== generation.ownerSessionId || !generation.runs.owns(identity.runId, identity.ownerRunId, identity.ownerSessionId))) return;
		return generation;
	};
	const beginProducer = (generation: OwnedGeneration | undefined): (() => void) => {
		if (!generation || generation.fenced) return () => undefined;
		generation.producerObligations += 1;
		let completed = false;
		return () => {
			if (completed) return;
			completed = true;
			generation.producerObligations = Math.max(0, generation.producerObligations - 1);
			wakeOwnedGeneration(generation);
			emitChildState();
		};
	};
	const diagnosticFacts = (runId: string): ReportDiagnosticFacts => {
		const metadata = diagnostics.get(runId)?.metadata ?? {};
		return {
			cancellationInitiator: typeof metadata.cancellationInitiator === "string" ? metadata.cancellationInitiator : undefined,
			spawnError: metadata.spawnError as ReportDiagnosticFacts["spawnError"],
			stream: metadata.stream as ReportDiagnosticFacts["stream"],
		};
	};
	const archiveFacts = (envelope: ReportEnvelope, delivery: ReportDelivery): Record<string, unknown> => ({
		identity: envelope.kind === "result" ? envelope.identity : { ownerRunId: envelope.ownerRunId, ownerSessionId: envelope.ownerSessionId, batchId: envelope.batchId, runIds: envelope.results.map((result) => result.identity.runId) },
		delivery: { ...delivery },
		children: (envelope.kind === "result" ? [envelope] : envelope.results).map((result) => ({ identity: result.identity, actualTaskHash: result.actualTaskHash, processOutcome: result.processOutcome, exitCode: result.exitCode, signal: result.signal, stopReason: result.stopReason, payloadOutcome: result.payloadOutcome, reviewVerdict: result.reviewVerdict, outputLimit: result.outputLimit, planResult: result.planResult, metadata: diagnostics.get(result.identity.runId)?.metadata ?? { processDiagnostics: "unavailable" } })),
	});
	const updateReportArchive = (deliveryId: string): void => {
		const retained = reportArchives.get(deliveryId);
		if (retained) reportStore.updateDiagnostics(deliveryId, retained.facts);
	};
	const listDeliveries = new Map<string, { state: "pending" | "enqueued" | "observed" | "delivery_failed"; customType: string; content: string }>();
	let childSequence = 0;
	const emitChildState = () => {
		if (!runs) return;
		const generation = ownedGeneration?.runs === runs ? ownedGeneration : undefined;
		const visibleDeliveries = [...deliveries.values()].filter((entry) => !generation || entry.generation === generation);
		pi.appendEntry("yokemate-child-state", { version: 1, ownerRunId: runs.ownerRunId, ownerSessionId: runs.ownerSessionId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", sequence: ++childSequence, children: runs.active(), deliveries: visibleDeliveries.map(({ delivery }) => ({ ...delivery })), producerObligations: generation?.producerObligations ?? 0, batchDispatches: generation?.batchDispatches ?? 0 });
	};
	pi.on("context", (event) => {
		let changed = false;
		for (const message of event.messages) {
			if (message.role !== "custom") continue;
			if (message.customType === "yokemate-list-key" || message.customType === "yokemate-list-aggregate") {
				const deliveryId = (message.details as { deliveryId?: string } | undefined)?.deliveryId;
				const delivery = deliveryId ? listDeliveries.get(deliveryId) : undefined;
				if (delivery && delivery.state === "enqueued") {
					delivery.state = "observed";
					pi.appendEntry("yokemate-list-delivery", { deliveryId, ...delivery });
				}
				continue;
			}
			if (message.customType !== "subagent-report") continue;
			for (const entry of deliveries.values()) {
				const { delivery, envelope } = entry;
				if (entry.generation && (entry.generation !== ownedGeneration || entry.generation.fenced)) continue;
				if (delivery.state === "observed" || message.content !== reportContent(envelope, delivery)) continue;
				const details = message.details as { deliveryId?: string; envelopeHash?: string } | undefined;
				if (details?.deliveryId !== delivery.deliveryId || details.envelopeHash !== delivery.envelopeHash) continue;
				delivery.state = "observed";
				delivery.observedAt = new Date().toISOString();
				for (const runId of delivery.runIds) {
					const diagnostic = diagnostics.get(runId);
					if (diagnostic) {
						const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
						states[delivery.deliveryId] = { state: delivery.state, envelopeHash: delivery.envelopeHash, observedAt: new Date().toISOString() };
						diagnostic.metadata.deliveries = states;
						diagnostic.save(true);
					}
				}
				const retained = reportArchives.get(delivery.deliveryId);
				if (retained) retained.facts = archiveFacts(envelope, delivery);
				updateReportArchive(delivery.deliveryId);
				reportArchives.delete(delivery.deliveryId);
				reportDisplays.delete(delivery.deliveryId);
				if (entry.generation) wakeOwnedGeneration(entry.generation);
				changed = true;
			}
		}
		if (changed) emitChildState();
	});
	pi.on("agent_settled", () => emitChildState());
	const coordinators = new CoordinatorRegistry();
	const listRuns = new ListRunRegistry();
	const authorityByCycle = new Map<string, DoAuthorityStore>();
	const sendListMessage = (message: { customType: string; content: string; display: boolean; details: unknown }) => {
		const deliveryId = createHash("sha256").update(`${message.customType}\u0000${JSON.stringify(message.details)}`).digest("hex");
		const delivery = listDeliveries.get(deliveryId) ?? { state: "pending" as const, customType: message.customType, content: message.content };
		listDeliveries.set(deliveryId, delivery);
		const persist = () => { try { pi.appendEntry("yokemate-list-delivery", { deliveryId, ...delivery, details: message.details }); } catch (error) { console.error(`[list delivery ${deliveryId}] ${(error as Error).message}`); } };
		persist();
		try {
			pi.sendMessage({ ...message, details: { deliveryId, payload: message.details } }, { deliverAs: "followUp", triggerTurn: true });
			delivery.state = "enqueued";
		} catch (error) {
			delivery.state = "delivery_failed";
			try { latestCtx?.ui.notify(`list outcome delivery failed ${deliveryId}: ${(error as Error).message}`, "error"); } catch {}
		}
		persist();
	};
	let listUnits = 0;
	const deferredListDeliveries = new Set<string>();
	const bufferedListMessages = new Map<string, Array<{ customType: string; content: string; display: boolean; details: unknown }>>();
	const deliverListMessage = (listRunId: string, message: { customType: string; content: string; display: boolean; details: unknown }) => {
		if (deferredListDeliveries.has(listRunId)) bufferedListMessages.set(listRunId, [...bufferedListMessages.get(listRunId) ?? [], message]);
		else sendListMessage(message);
	};
	const flushListDelivery = (listRunId: string) => {
		deferredListDeliveries.delete(listRunId);
		for (const message of bufferedListMessages.get(listRunId) ?? []) sendListMessage(message);
		bufferedListMessages.delete(listRunId);
		listRuns.flushAggregate(listRunId);
	};
	listRuns.onTerminal((run, entry) => {
		if (run.identity.mode === "do") {
			authorityByCycle.get(entry.keyRunId)?.finish(entry.keyRunId);
			authorityByCycle.delete(entry.keyRunId);
		}
		if (entry.immediate?.state === "accepted" && !listRuns.wasLifetimeReleased(entry.keyRunId)) { listUnits = Math.max(0, listUnits - 1); activeUnits = Math.max(0, activeUnits - 1); }
		deliverListMessage(run.identity.listRunId, { customType: "yokemate-list-key", content: `[${run.identity.mode} ${entry.key} ${entry.keyRunId}] ${entry.terminal?.outcome}: ${entry.terminal?.reason ?? "complete"}`, display: true, details: { listRunId: run.identity.listRunId, keyRunId: entry.keyRunId, key: entry.key, terminal: entry.terminal } });
	});
	listRuns.onAggregate((aggregate) => deliverListMessage(aggregate.listRunId, { customType: "yokemate-list-aggregate", content: `[${aggregate.mode} list ${aggregate.listRunId}] ${aggregate.results.map((result) => `${result.key}:${result.terminal?.outcome ?? "refused"}`).join(", ")}`, display: true, details: aggregate }));
	const recordingPlans = new Set<string>();
	const stoppedPlanRuns = new Set<string>();
	const lockedRecordingPlans = new Set<string>();
	const recorderControllers = new Map<string, AbortController>();
	const recorderCompletions = new Map<string, Promise<void>>();
	const recorderFences = new PlanRecorderFences();
	const shipPermits = new ShipPermitStore();
	const workflowIngress = new WorkflowIngressWitnessStore();
	const breakGlassPermits = new BreakGlassPermitStore();
	let ingressWitness: WorkflowIngressWitness | undefined;
	let uninstallIngress: (() => void) | undefined;
	let authority: DoAuthorityStore | undefined;
	const reviewReworks = new Map<string, { store: ReviewReworkStore; stopObserver: () => void }>();
	let workflowExtraction: PendingWorkflowExtraction | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	const observedTurnSignals = new WeakSet<AbortSignal>();
	const warnedWorkflowExtractions = new WeakSet<PendingWorkflowExtraction>();
	interface WorkflowGenerationCapture { parent: ApprovalParent; store: DoAuthorityStore; generation: InputGeneration; operation?: PendingWorkflowExtraction }
	type WorkflowConsumerMetadata = { requestId?: string; toolCallId?: string; listRunId?: string; keyRunId?: string };
	type PlanRecordCompletion = { runId?: string; reason: string; facts: Record<string, unknown>; publications: PublicationOutcome[]; handoff: "plan-only" | "unavailable" | "started" | "refused" };
	const planRunGenerations = new Map<string, WorkflowGenerationCapture>();
	const planRunMetadata = new Map<string, WorkflowConsumerMetadata>();
	const planRecordGenerations = new Map<number, WorkflowGenerationCapture>();
	const planRecordCompletions = new Map<number, Promise<PlanRecordCompletion>>();
	const localPreparedPlanRequests = new Map<number, { requestedPath: string; contentHash: string; scope: PlanWriterScope; binding: PlanBinding }>();
	const captureWorkflowGeneration = (): WorkflowGenerationCapture | undefined => {
		if (!authority || !controlIdentity) return;
		const generation = authority.generation();
		const operation = workflowExtraction?.matches(controlIdentity, authority, generation) ? workflowExtraction : undefined;
		return { parent: { ...controlIdentity }, store: authority, generation, operation };
	};
	const safeWorkflowId = (value: unknown): string | undefined => {
		if (typeof value !== "string") return;
		return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : createHash("sha256").update(value).digest("hex");
	};
	const appendWorkflowEntry = (type: "yokemate-workflow-extraction" | "yokemate-workflow-consumer", data: Record<string, unknown>): void => {
		try { pi.appendEntry(type, data); } catch {}
	};
	const assertWorkflowCapture = (capture: WorkflowGenerationCapture): void => {
		if (!authority || !controlIdentity || capture.store !== authority || capture.parent.sessionId !== controlIdentity.sessionId || capture.parent.runtimeId !== controlIdentity.runtimeId) throw new Error("stale do approval input generation");
		authority.assertGeneration(capture.generation);
	};
	const awaitWorkflowGeneration = async (capture: WorkflowGenerationCapture | undefined, ctx: ExtensionContext, consumer: Record<string, unknown>, blocking = true): Promise<WorkflowExtractionTerminal | undefined> => {
		if (!capture?.operation) return;
		appendWorkflowEntry("yokemate-workflow-consumer", { phase: "wait", parentSessionId: capture.parent.sessionId, parentRuntimeId: capture.parent.runtimeId, serial: capture.generation.serial, revision: capture.generation.revision, inputHash: capture.generation.inputHash, decisionCode: "pending", ...consumer });
		const terminal = await capture.operation.wait();
		assertWorkflowCapture(capture);
		appendWorkflowEntry("yokemate-workflow-consumer", { phase: "decision", parentSessionId: capture.parent.sessionId, parentRuntimeId: capture.parent.runtimeId, serial: capture.generation.serial, revision: capture.generation.revision, inputHash: capture.generation.inputHash, outcome: terminal.outcome, decisionCode: terminal.outcome, elapsedMs: terminal.elapsedMs, ...consumer });
		if (blocking && ["timeout", "model_error", "invalid"].includes(terminal.outcome)) {
			if (!warnedWorkflowExtractions.has(capture.operation)) {
				warnedWorkflowExtractions.add(capture.operation);
				ctx.ui.notify(`workflow extraction unavailable: outcome=${terminal.outcome}, elapsedMs=${terminal.elapsedMs}; no inferred workflow approval`, "warning");
			}
			throw new Error(`workflow extraction unavailable: outcome=${terminal.outcome}; no inferred workflow approval`);
		}
		return terminal;
	};
	let ownedBinding: PlanBinding | undefined;
	const coordinatorUnits = new Set<string>();
	const releaseCoordinatorUnit = (runId: string): void => {
		if (coordinatorUnits.delete(runId)) activeUnits -= 1;
		authorityByCycle.get(runId)?.finish(runId);
		authorityByCycle.delete(runId);
	};
	let controlServer: import("node:net").Server | undefined;
	let controlIdentity: { sessionId: string; runtimeId: string } | undefined;
	const auditRecoveryPreviews = (previews: readonly BreakGlassPreview[], outcome: "refusal" | "revoke" | "expiry"): void => {
		if (!previews.length || !controlIdentity) return;
		const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		try {
			db.exec("BEGIN IMMEDIATE");
			for (const preview of previews) {
				appendRecoveryAttempt(db, { candidateId: preview.candidateId, ticket: preview.ticket, action: preview.action, inputGeneration: preview.inputGeneration, inputHash: preview.inputHash, scopeHash: preview.scopeHash, targetHash: preview.targetHash, sourceUid: process.getuid!(), sourceSessionId: controlIdentity.sessionId, sourceRuntimeId: controlIdentity.runtimeId, payloadHash: preview.candidateHash, failureHash: preview.failureHash, reason: preview.reason, outcome });
				appendRecoveryDecision(db, { candidateId: preview.candidateId, ticket: preview.ticket, action: preview.action, inputHash: preview.inputHash, sourceUid: process.getuid!(), sourceSessionId: controlIdentity.sessionId, sourceRuntimeId: controlIdentity.runtimeId, code: `${outcome}-permit`, blockers: [`${outcome}-permit`], reason: preview.reason, outcome });
			}
			db.exec("COMMIT");
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch {}
			throw error;
		} finally { db.close(); }
	};
	let uiTail: Promise<void> = Promise.resolve();
	const uiAbortByRun = new Map<string, AbortController>();
	const suppressedCancellationReports = new Set<string>();
	const cancellingCoordinators = new Map<string, Promise<import("../../../src/coordinator-runtime.ts").CoordinatorRun>>();
	const cancelCoordinator = (runId: string, reason: "parent_control_cancel" | "parent_cancel_run", suppressReport = false) => {
		const existing = cancellingCoordinators.get(runId);
		if (existing) return existing;
		const run = coordinators.get(runId);
		if (!run) return Promise.reject(new Error(`unknown coordinator run ${runId}`));
		if (["done", "blocked"].includes(run.state)) return Promise.resolve(run);
		const operation = (async () => {
			coordinators.finalize(runId, "blocked", "cancelled");
			if (suppressReport) suppressedCancellationReports.add(runId);
			coordinatorAdmissions.delete(runId);
			releaseCoordinatorUnit(runId);
			uiAbortByRun.get(runId)?.abort();
			uiAbortByRun.delete(runId);
			const rpc = rpcByRun.get(runId);
			untrackRunning(rpc?.process);
			coordinatorChildren.delete(runId);
			await rpc?.stop(reason);
			rpcByRun.delete(runId);
			return run;
		})();
		cancellingCoordinators.set(runId, operation);
		void operation.then(() => cancellingCoordinators.delete(runId), () => cancellingCoordinators.delete(runId));
		return operation;
	};
	const revokeReviewRun = async (reviewRunId: string, reason: string, stopObserver = true) => {
		const review = reviewReworks.get(reviewRunId);
		if (!review) return;
		for (const runId of review.store.revoke()) {
			listRuns.cancel(runId, reason);
			if (coordinators.get(runId)) await cancelCoordinator(runId, "parent_cancel_run", true).catch(() => {});
		}
		if (stopObserver) review.stopObserver();
	};
	const upgradeRecordingFence = (runId: string): boolean => {
		if (!recordingPlans.has(runId)) return false;
		recorderFences.fence(runId, true);
		recorderControllers.get(runId)?.abort();
		return true;
	};
	const fenceTargetedWorkflow = (tickets: readonly string[], explicitRunIds: readonly string[], reason: string, store = authority) => {
		const runIds = new Set(explicitRunIds);
		for (const ticket of new Set(tickets)) for (const runId of store?.revoke(ticket) ?? []) runIds.add(runId);
		let cancelled = false;
		const immediateRunIds: string[] = [];
		for (const runId of runIds) {
			planRunGenerations.delete(runId);
			planRunMetadata.delete(runId);
			if (recordingPlans.has(runId)) {
				recorderFences.fence(runId, true);
				recorderControllers.get(runId)?.abort();
				cancelled = true;
				continue;
			}
			immediateRunIds.push(runId);
		}
		cancelled = listRuns.cancelMany(immediateRunIds, reason) || cancelled;
		const coordinatorRunIds = immediateRunIds.filter((runId) => Boolean(coordinators.get(runId)));
		return { runIds, coordinatorRunIds, cancelled: cancelled || coordinatorRunIds.length > 0 };
	};
	const fenceListRuns = async (reason: string) => {
		for (const runId of recordingPlans) upgradeRecordingFence(runId);
		const entries = [...listRuns.activeEntries()];
		const cancellations: string[] = [];
		const coordinatorStops: string[] = [];
		const agentStops: string[] = [];
		for (const entry of entries) {
			if (recordingPlans.has(entry.keyRunId)) {
				recorderFences.fence(entry.keyRunId, true);
				recorderControllers.get(entry.keyRunId)?.abort();
				continue;
			}
			cancellations.push(entry.keyRunId);
			if (coordinators.get(entry.keyRunId)) coordinatorStops.push(entry.keyRunId);
			if (typeof entry.immediate?.facts?.agentName === "string") agentStops.push(entry.immediate.facts.agentName);
		}
		listRuns.cancelMany(cancellations, reason);
		await Promise.all([
			...coordinatorStops.map((runId) => cancelCoordinator(runId, "parent_cancel_run", true)),
			...agentStops.map((agentName) => herdrAsync(["agent", "stop", agentName]).catch(() => {})),
		]);
	};
	const revokeAuthority = async (reason: WorkflowCancellationReason = "parent_cancel") => {
		shipPermits.invalidate();
		workflowExtraction?.cancel(reason);
		const stopped = authority?.revoke() ?? [];
		for (const runId of stopped) authorityByCycle.delete(runId);
		auditRecoveryPreviews(breakGlassPermits.revoke(), "revoke");
		workflowIngress.revoke();
		ingressWitness = undefined;
		await Promise.all([...reviewReworks.keys()].map((runId) => revokeReviewRun(runId, "parent runtime changed")));
		await fenceListRuns("parent runtime changed");
		for (const runId of stopped) {
			if (coordinators.get(runId)) await cancelCoordinator(runId, "parent_cancel_run");
			else listRuns.cancel(runId, "parent runtime changed");
		}
	};
	const endOwnedReview = async (reason: string) => {
		if (process.env.YOKEMATE_MODE !== "review" || !process.env.YOKEMATE_TICKET || !process.env.YOKEMATE_REVIEW_RUN_ID || !process.env.PI_SESSION_ID) return;
		const reply = await requestReviewControl(ENGINE_ROOT, "review-ended", { ticket: process.env.YOKEMATE_TICKET, runId: process.env.YOKEMATE_REVIEW_RUN_ID, reason }, currentControlOrigin(ENGINE_ROOT), resolveCoordinatorParent(ENGINE_ROOT));
		if (reply.state !== "accepted") throw new Error(reply.reason ?? "review authority fencing was refused");
	};
	const fenceOwnedAuthority = async (reason: WorkflowCancellationReason) => {
		const revoked = revokeAuthority(reason);
		try { await endOwnedReview("review runtime changed"); }
		catch (error) { latestCtx?.ui.notify(`review runtime change blocked: ${(error as Error).message}`, "error"); throw error; }
		await revoked;
	};
	pi.on("session_before_switch", () => fenceOwnedAuthority("session_switch"));
	pi.on("session_before_fork", () => fenceOwnedAuthority("session_fork"));
	pi.on("session_before_tree", () => fenceOwnedAuthority("session_tree"));
	let ownedReadyRunId: string | undefined;
	let finishingCoordinatorRunId: string | undefined;
	const sendCoordinatorTerminal = (run: CoordinatorRun, outcome: "done" | "blocked", summary: string, reason: string | undefined, verification: unknown, rpcDiagnostic?: Record<string, unknown>, awaitLateDiagnostics = false): void => {
		const canonical = `[coordinator ${run.identity.mode} ${run.identity.ticket}] ${outcome}: ${outcome === "blocked" && summary === "coordinator stopped" ? reason : summary}`;
		const artifactId = coordinatorArtifactId(run.identity.parentSessionId, run.identity.runId);
		const facts: Record<string, unknown> = { identity: run.identity, terminal: { outcome, summary, reason, verification }, process: rpcDiagnostic ?? { state: "unavailable" } };
		const stored = reportStore.writeReport(artifactId, canonical, facts);
		reportArchives.set(artifactId, { facts });
		const admission = coordinatorAdmissions.get(run.identity.runId);
		const display = buildCoordinatorDisplay(admission, Date.now(), outcome, summary, reason, stored.archive);
		coordinatorAdmissions.delete(run.identity.runId);
		if (!awaitLateDiagnostics) reportArchives.delete(artifactId);
		pi.sendMessage({ customType: "subagent-report", content: canonical, display: true, details: { runId: run.identity.runId, mode: run.identity.mode, tickets: run.request.tickets, outcome, verification, display } }, { deliverAs: "followUp", triggerTurn: true });
	};
	const startWorkflowExtraction = (raw: string, ctx: ExtensionContext, parent: ApprovalParent, store: DoAuthorityStore, generation: InputGeneration): void => {
		const operation = new PendingWorkflowExtraction(parent, store, generation);
		workflowExtraction = operation;
		appendWorkflowEntry("yokemate-workflow-extraction", { phase: "start", parentSessionId: parent.sessionId, parentRuntimeId: parent.runtimeId, serial: generation.serial, revision: generation.revision, inputHash: generation.inputHash, startedAt: new Date(operation.startedAtWall).toISOString(), provider: ctx.model?.provider, model: ctx.model?.id, bindingCount: 0, bindingBytes: 0 });
		void operation.wait().then((terminal) => appendWorkflowEntry("yokemate-workflow-extraction", { phase: "terminal", parentSessionId: parent.sessionId, parentRuntimeId: parent.runtimeId, serial: generation.serial, revision: generation.revision, inputHash: generation.inputHash, ...terminal }));
		setImmediate(() => operation.start(async (signal) => {
			const model = ctx.model;
			const provider = model?.provider;
			const modelId = model?.id;
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { outcome: "model_error", provider, model: modelId };
			let bindings: PlanBinding[];
			try { bindings = await readWorkflowBindingSnapshot(ENGINE_ROOT, signal); }
			catch { return { outcome: signal.aborted ? "none" : "model_error", provider, model: modelId }; }
			if (!operation.isCurrent(parent, store, generation)) return { outcome: "none", provider, model: modelId };
			const bindingCount = bindings.length;
			const bindingBytes = Buffer.byteLength(JSON.stringify(bindings), "utf8");
			let message: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
			try {
				message = await ctx.modelRegistry.complete(model, { systemPrompt: WORKFLOW_EXTRACTION_INSTRUCTION, messages: [{ role: "user", content: JSON.stringify({ raw, bindings }), timestamp: Date.now() }] }, { signal, maxTokens: 1024 });
			} catch { return { outcome: signal.aborted ? "none" : "model_error", provider, model: modelId, bindingCount, bindingBytes }; }
			if (!operation.isCurrent(parent, store, generation)) return { outcome: "none", provider, model: modelId, bindingCount, bindingBytes };
			if (message.stopReason === "error" || message.stopReason === "aborted") return { outcome: "model_error", provider, model: modelId, bindingCount, bindingBytes };
			if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return { outcome: "invalid", provider, model: modelId, bindingCount, bindingBytes };
			const response = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
			if (Buffer.byteLength(response, "utf8") > 16 * 1024) return { outcome: "invalid", provider, model: modelId, bindingCount, bindingBytes };
			let extraction;
			try { extraction = validateExtraction(JSON.parse(response), raw, bindings); }
			catch { return { outcome: "invalid", provider, model: modelId, bindingCount, bindingBytes }; }
			if (extraction.kind === "none") return { outcome: "none", provider, model: modelId, bindingCount, bindingBytes };
			if (extraction.kind === "advance-plan-do") return { outcome: "approval", action: extraction.kind, provider, model: modelId, bindingCount, bindingBytes, effect: () => store.approve("advance-plan-do", extraction.ticket, undefined, generation) };
			if (extraction.kind === "approve-ready-do") {
				let current: PlanBinding;
				try {
					current = readRecordedPlanBinding(ENGINE_ROOT, extraction.ticket);
					const snapshotted = bindings.find((binding) => binding.ticket === extraction.ticket);
					if (!snapshotted) return { outcome: "invalid", provider, model: modelId, bindingCount, bindingBytes };
					assertPlanBinding(snapshotted, current);
				} catch { return { outcome: "invalid", provider, model: modelId, bindingCount, bindingBytes }; }
				return { outcome: "approval", action: extraction.kind, provider, model: modelId, bindingCount, bindingBytes, effect: () => store.approve("post-plan-approval", extraction.ticket, current, generation) };
			}
			return { outcome: "approval", action: extraction.kind, provider, model: modelId, bindingCount, bindingBytes, effect: () => {
				const fenced = fenceTargetedWorkflow([extraction.ticket], [], "workflow revoked", store);
				setImmediate(() => { void Promise.all(fenced.coordinatorRunIds.map((runId) => cancelCoordinator(runId, "parent_cancel_run"))).catch(() => {}); });
			} };
		}));
	};
	pi.on("input", async (event, ctx) => {
		if (event.source === "interactive" && ctx.mode === "tui" && process.env.YOKEMATE_MODE === "review" && process.env.YOKEMATE_ROLE === "coordinator" && process.env.YOKEMATE_TICKET && process.env.YOKEMATE_REVIEW_RUN_ID) {
			const ticket = process.env.YOKEMATE_TICKET;
			const runId = process.env.YOKEMATE_REVIEW_RUN_ID;
			const origin = currentControlOrigin(ENGINE_ROOT, ctx.sessionManager.getSessionId());
			let controller: AbortController | undefined;
			let timer: NodeJS.Timeout | undefined;
			const model = ctx.model;
			const startedAt = performance.now();
			const inputHash = sha256(event.text);
			let serial: number | null = null;
			let revision: number | null = null;
			let stopReason = "unknown";
			let responseHash: string | null = null;
			let responseBytes = 0;
			let validation: "not_run" | "rejected" | "accepted" = "not_run";
			let inputControl: "not_run" | "error" | "refused" | "accepted" = "not_run";
			let extractionControl: "not_run" | "error" | "refused" | "accepted" = "not_run";
			let outcome: "refused" | "accepted" = "refused";
			let reasonCode: "settings_error" | "input_control_error" | "input_control_refused" | "auth_unavailable" | "model_error" | "timeout" | "unclean_response" | "invalid_json" | "invalid_evidence" | "extraction_control_error" | "extraction_control_refused" | "none" | "rework" | "revoke" = "settings_error";
			const persist = (phase: "start" | "terminal") => {
				try {
					pi.appendEntry("yokemate-review-extraction", { version: 1, phase, reviewRunId: safeWorkflowId(runId), serial, revision, inputHash, provider: safeWorkflowId(model?.provider) ?? "unknown", model: safeWorkflowId(model?.id) ?? "unknown", outcome: phase === "start" ? "pending" : outcome, reasonCode: phase === "start" ? "pending" : reasonCode, stopReason, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), responseHash, responseBytes, validation, inputControl, extractionControl });
				} catch {}
			};
			persist("start");
			try {
				readRuntimeSettings(ENGINE_ROOT);
				reasonCode = "input_control_error";
				inputControl = "error";
				const parent = resolveCoordinatorParent(ENGINE_ROOT);
				const begun = await requestReviewControl(ENGINE_ROOT, "review-input", { ticket, runId, raw: event.text }, origin, parent);
				reasonCode = "input_control_refused";
				inputControl = "refused";
				if (begun.state !== "accepted" || typeof begun.generation !== "object" || !begun.generation) throw new Error(reasonCode);
				inputControl = "accepted";
				serial = Number.isSafeInteger(begun.generation.serial) && begun.generation.serial >= 0 ? begun.generation.serial : null;
				revision = Number.isSafeInteger(begun.generation.revision) && begun.generation.revision >= 0 ? begun.generation.revision : null;
				reasonCode = "auth_unavailable";
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(reasonCode);
				controller = new AbortController();
				reasonCode = "model_error";
				const message = await Promise.race([
					ctx.modelRegistry.complete(model, { systemPrompt: REVIEW_REWORK_EXTRACTION_INSTRUCTION, messages: [{ role: "user", content: JSON.stringify({ raw: event.text }), timestamp: Date.now() }] }, { signal: controller.signal, maxTokens: 512 }),
					new Promise<never>((_, reject) => { timer = setTimeout(() => { reasonCode = "timeout"; controller!.abort(); reject(new Error(reasonCode)); }, 15_000); }),
				]);
				clearTimeout(timer);
				reasonCode = "unclean_response";
				stopReason = ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "unknown";
				const response = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
				responseHash = sha256(response);
				responseBytes = Buffer.byteLength(response);
				if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) throw new Error(reasonCode);
				validation = "rejected";
				reasonCode = "invalid_json";
				const value: unknown = JSON.parse(response);
				reasonCode = "invalid_evidence";
				const extraction = adaptReviewReworkQuotes(value, event.text, ticket);
				validation = "accepted";
				reasonCode = "extraction_control_error";
				extractionControl = "error";
				const extracted = await requestReviewControl(ENGINE_ROOT, "review-extraction", { ticket, runId, generation: begun.generation, extraction }, origin, parent);
				reasonCode = "extraction_control_refused";
				extractionControl = "refused";
				if (extracted.state !== "accepted") throw new Error(reasonCode);
				extractionControl = "accepted";
				outcome = "accepted";
				reasonCode = extraction.kind;
			} catch { ctx.ui.notify(`review verdict extraction unavailable: reason=${reasonCode}; no inferred rework approval`, "warning"); }
			finally { clearTimeout(timer); controller?.abort(); persist("terminal"); }
			return;
		}
		if (event.source !== "interactive" || ctx.mode !== "tui" || process.env.YOKEMATE_MODE || process.env.YOKEMATE_ROLE) return;
		const text = event.text.trim();
		const sessionId = ctx.sessionManager.getSessionId();
		if (!controlIdentity || controlIdentity.sessionId !== sessionId || !authority) {
			ctx.ui.notify("workflow approval unavailable: no verified main parent runtime", "error");
			return { action: "handled" as const };
		}
		workflowExtraction?.cancel("new_input");
		const witnessed = ingressWitness && !ingressWitness.consumed && ingressWitness.sessionId === sessionId && ingressWitness.runtimeId === controlIdentity.runtimeId && ingressWitness.raw === event.text ? ingressWitness : undefined;
		const generation = witnessed ? authority.generation() : authority.beginInput(event.text);
		if (!witnessed) { auditRecoveryPreviews(breakGlassPermits.revoke(), "revoke"); workflowIngress.revoke(); ingressWitness = undefined; }
		shipPermits.invalidate();
		try {
			const ship = text.match(/^\/ship\s+(.+)$/);
			if (ship) {
				const tickets = ship[1]!.split(/\s+/).filter((word) => /^[A-Z][A-Z0-9]*-\d+$/.test(word));
				if (tickets.length) shipPermits.observeInteractiveShip(tickets, sessionId);
				return;
			}
			if (/^\/(?:plan|split)(?:\s|$)/.test(text)) return;
			const exact = text.match(/^\/do\s+(.+)$/);
			if (exact) {
				const words = exact[1]!.split(/\s+/);
				const tickets: string[] = [];
				let plan: string | undefined;
				for (let index = 0; index < words.length; index++) {
					const word = words[index]!;
					if (word === "--model" || word === "--plan") {
						const value = words[++index];
						if (!value) throw new Error(`${word} needs a value`);
						if (word === "--plan") plan = value;
						continue;
					}
					if (word.startsWith("--plan=")) { plan = word.slice("--plan=".length); continue; }
					if (word.startsWith("--model=")) continue;
					for (const ticket of word.match(/(?:^|[^A-Z0-9-])([A-Z][A-Z0-9]*-\d+)(?=$|[^A-Z0-9-])/g) ?? []) {
						const match = /([A-Z][A-Z0-9]*-\d+)/.exec(ticket);
						if (match) tickets.push(match[1]!);
					}
				}
				if (!tickets.length || new Set(tickets).size !== tickets.length) throw new Error("do approval needs distinct ordered tickets");
				for (const ticket of tickets) try {
					const binding = readRecordedPlanBinding(ENGINE_ROOT, ticket);
					if (plan && fs.realpathSync(path.resolve(ctx.cwd, plan)) !== binding.path) throw new Error("do approval --plan differs from the current recorded plan");
					authority.approve("exact-do", binding.ticket, binding, generation);
				} catch (error) { ctx.ui.notify(`${ticket}: ${(error as Error).message}`, "error"); }
				return;
			}
			if (text.startsWith("/")) return;
			if (!isWorkflowCandidate(event.text)) {
				const skippedAt = new Date().toISOString();
				const skippedParent = { ...controlIdentity };
				const skippedGeneration = { ...generation };
				setImmediate(() => appendWorkflowEntry("yokemate-workflow-extraction", { phase: "terminal", parentSessionId: skippedParent.sessionId, parentRuntimeId: skippedParent.runtimeId, serial: skippedGeneration.serial, revision: skippedGeneration.revision, inputHash: skippedGeneration.inputHash, startedAt: skippedAt, finishedAt: skippedAt, elapsedMs: 0, outcome: "none", action: "skipped", bindingCount: 0, bindingBytes: 0 }));
				return;
			}
			startWorkflowExtraction(event.text, ctx, controlIdentity, authority, generation);
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
			return { action: "handled" as const };
		}
	});
	const workflowConsumerFacts = (kind: string, metadata: WorkflowConsumerMetadata, ticket?: string): Record<string, unknown> => ({ consumerKind: kind, ...(ticket ? { ticket } : {}), ...(safeWorkflowId(metadata.requestId) ? { requestId: safeWorkflowId(metadata.requestId) } : {}), ...(safeWorkflowId(metadata.toolCallId) ? { toolCallId: safeWorkflowId(metadata.toolCallId) } : {}), ...(safeWorkflowId(metadata.listRunId) ? { listRunId: safeWorkflowId(metadata.listRunId) } : {}), ...(safeWorkflowId(metadata.keyRunId) ? { keyRunId: safeWorkflowId(metadata.keyRunId) } : {}) });
	const startOneCoordinator = async (request: CoordinatorRequest, ctx: ExtensionContext, origin: { YOKEMATE_MODE?: string; YOKEMATE_TICKET?: string; YOKEMATE_ROLE?: "coordinator" | "executor"; sessionId?: string; cwd?: string }, settings: RuntimeSettings | undefined, lane?: { context: KeyRunContext; doBinding?: PlanBinding; review?: { store: ReviewReworkStore; operationId: string } }, metadata: WorkflowConsumerMetadata = {}) => {
		const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
		validateCoordinatorRequest(request);
		let checks = coordinatorChecks(settings ?? readRuntimeSettings(ENGINE_ROOT));
		const refusal = checks.checkCaller(origin, request);
		if (refusal) throw new Error(refusal);
		const workflowCapture = request.mode === "do" && !lane ? captureWorkflowGeneration() : undefined;
		if (request.mode === "do" && !lane) await awaitWorkflowGeneration(workflowCapture, ctx, workflowConsumerFacts("do", metadata, request.tickets[0]));
		if (workflowCapture) assertWorkflowCapture(workflowCapture);
		settings = lane?.context.settings ?? readRuntimeSettings(ENGINE_ROOT);
		checks = coordinatorChecks(settings);
		const currentRefusal = checks.checkCaller(origin, request);
		if (currentRefusal) throw new Error(currentRefusal);
		if (request.mode === "ship" && !lane) {
			if (!shipPermits.consume(request.tickets, origin.sessionId ?? "main")) throw new Error("ship requires the current interactive /ship command in the main chat");
			if (checks.needsShipConfirmation(origin) && (!ctx.hasUI || !(await ctx.ui.confirm("Ship merges", "Confirm this run is on the engineer's word.")))) throw new Error("ship confirmation declined");
		}
		let doBinding: PlanBinding | undefined = lane?.doBinding;
		if (request.mode === "do" && !lane) {
			if (!authority || !controlIdentity) throw new Error("initial do requires a current interactive approval in its live parent");
			doBinding = readRecordedPlanBinding(root, request.tickets[0]!);
			if (request.plan && fs.realpathSync(path.resolve(origin.cwd ?? root, request.plan)) !== doBinding.path) throw new Error("do approval --plan differs from the recorded binding");
			authority.check(request.tickets[0]!, doBinding, { ...controlIdentity, sessionId: origin.sessionId ?? "" });
		}
		const admission = lane ? undefined : checks.checkAdmission(activeUnits);
		if (admission) throw new Error(admission);
		if (!lane) activeUnits += 1;
		let run: CoordinatorRun | undefined;
		let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
		let reportBlocked: ((reason: string) => void) | undefined;
		let cleanupReservation: ((reason: string) => Promise<void>) | undefined;
		const finishCalls = new Set<string>();
		try {
			run = coordinators.reserve(request, origin, origin.sessionId ?? "main", request.model ?? "pending", request.mode === "do" ? path.join(root, "work", request.tickets[0]!) : root, [], checks.rejectDuplicate(request.mode), lane ? { runId: lane.context.keyRunId, parentRunId: lane.context.listRunId } : undefined);
			if (!run) throw new Error("coordinator reservation failed");
			const ownedRun = run;
			coordinatorAdmissions.set(ownedRun.identity.runId, { startedAt: Date.now(), taskExcerpt: reportTaskExcerpt(request.tickets.join("+")) });
			const settleUnit = (outcome: "done" | "blocked", reason?: string, facts?: Record<string, unknown>) => {
				if (lane?.review) lane.review.store.finish(ownedRun.identity.runId);
				return lane ? lane.context.terminal({ outcome, reason, facts }) : (releaseCoordinatorUnit(ownedRun.identity.runId), true);
			};
			if (!lane) coordinatorUnits.add(ownedRun.identity.runId);
			if (doBinding && !lane) {
				authority!.consume(request.tickets[0]!, doBinding, controlIdentity!, ownedRun.identity.runId);
				authorityByCycle.set(ownedRun.identity.runId, authority!);
			}
			let cleanup: Promise<void> | undefined;
			cleanupReservation = (reason) => cleanup ??= (async () => {
				uiAbortByRun.get(ownedRun.identity.runId)?.abort();
				uiAbortByRun.delete(ownedRun.identity.runId);
				untrackRunning(rpc?.process);
				coordinatorChildren.delete(ownedRun.identity.runId);
				await rpc?.stop();
				if (reportBlocked) reportBlocked(reason);
				else {
					coordinators.finalize(ownedRun.identity.runId, "blocked", reason);
					coordinatorAdmissions.delete(ownedRun.identity.runId);
					settleUnit("blocked", reason);
				}
				rpcByRun.delete(ownedRun.identity.runId);
			})();
			const prepared = request.mode === "do" ? prepareDo(root, request, origin, settings) : await prepareShip(root, request);
			if (ownedRun.state === "blocked") throw new Error("coordinator was cancelled during preparation");
			if (doBinding) {
				const current = readRecordedPlanBinding(root, request.tickets[0]!);
				if (lane?.review) lane.review.store.checkCycle(ownedRun.identity.runId, current);
				else authority!.checkCycle(ownedRun.identity.runId, current);
				prepared.doBinding = doBinding;
			}
			ownedRun.identity.model = prepared.model;
			ownedRun.identity.cwd = prepared.cwd;
			ownedRun.identity.project = prepared.parts.map((part) => part.repo);
			coordinators.setPrepared(ownedRun.identity.runId, prepared);
			let terminalReported = false;

			reportBlocked = (reason: string) => {
				if (finishingCoordinatorRunId === ownedRun.identity.runId || terminalReported) return;
				terminalReported = true;
				if (suppressedCancellationReports.delete(ownedRun.identity.runId)) return;
				uiAbortByRun.get(ownedRun.identity.runId)?.abort();
				uiAbortByRun.delete(ownedRun.identity.runId);
				const blocked = coordinators.finalize(ownedRun.identity.runId, "blocked", reason);
				const verification = verifyCoordinatorOutcome(root, prepared, { outcome: "blocked", summary: "coordinator stopped", reason }, rpc?.childState.verificationCount("blocked", reason) ?? 1);
				settleUnit("blocked", reason, { verification });
				pi.appendEntry("yokemate-coordinator-run", { identity: blocked.identity, state: "blocked", verification, summary: "coordinator stopped", reason });
				sendCoordinatorTerminal(blocked, "blocked", "coordinator stopped", reason, verification, rpc?.diagnosticSnapshot(), rpc?.process.exitCode === null);
				untrackRunning(rpc?.process);
				void rpc?.stop();
				rpcByRun.delete(ownedRun.identity.runId);
			};
			const resolvedModel = resolveCoordinatorModel(prepared.model, ctx.modelRegistry);
			if (resolvedModel.warning) ctx.ui.notify(resolvedModel.warning, "warning");
			if (request.mode === "do") markDoRunning(root, prepared, origin, settings);
			rpc = startCoordinatorRpc(prepared, ownedRun.identity, resolvedModel.expected, { onEvent: (event) => {
				if (rpc && !terminalReported) {
					try {
						if (doBinding && (event.type === "agent_settled" || event.type === "tool_execution_start")) {
							const current = readRecordedPlanBinding(root, request.tickets[0]!);
							if (lane?.review) lane.review.store.checkCycle(ownedRun.identity.runId, current);
							else authority!.checkCycle(ownedRun.identity.runId, current);
						}
						continueOwnedCoordinator(rpc, event, (reason) => reportBlocked?.(reason));
					}
					catch (error) { reportBlocked?.((error as Error).message); }
				}
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
				settleUnit(proposal.outcome, proposal.reason, { verification });
				pi.appendEntry("yokemate-coordinator-run", { identity: ownedRun.identity, state: proposal.outcome, verification, summary: proposal.summary, reason: proposal.reason });
				sendCoordinatorTerminal(ownedRun, proposal.outcome, proposal.summary, proposal.reason, verification, rpc?.diagnosticSnapshot(), rpc?.process.exitCode === null);
				untrackRunning(rpc?.process);
				void rpcByRun.get(ownedRun.identity.runId)?.stop(); rpcByRun.delete(ownedRun.identity.runId);
			}, onUiRequest: (event, reply) => {
				if (event.method === "setWidget" && event.widgetKey === "subagent-running") {
					if (terminalReported || ["done", "blocked"].includes(ownedRun.state)) return;
					if (event.widgetLines === undefined) coordinatorChildren.delete(ownedRun.identity.runId);
					else if (Array.isArray(event.widgetLines) && event.widgetLines.every((line) => typeof line === "string"))
						coordinatorChildren.set(ownedRun.identity.runId, event.widgetLines);
					else return;
					renderRunningWidget();
					return;
				}
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
			}, onDiagnostic: (snapshot, completed) => {
				const artifactId = coordinatorArtifactId(ownedRun.identity.parentSessionId, ownedRun.identity.runId);
				const retained = reportArchives.get(artifactId);
				if (!retained) return;
				retained.facts = { ...retained.facts, process: snapshot };
				reportStore.updateDiagnostics(artifactId, retained.facts);
				if (completed) reportArchives.delete(artifactId);
			}, onBlocked: reportBlocked });
			rpcByRun.set(ownedRun.identity.runId, rpc);
			await rpc.ready;
			if (doBinding) {
				const current = readRecordedPlanBinding(root, request.tickets[0]!);
				if (lane?.review) lane.review.store.checkCycle(ownedRun.identity.runId, current);
				else authority!.checkCycle(ownedRun.identity.runId, current);
			}
			coordinators.attachProcess(ownedRun.identity.runId, rpc.process);
			const { mode, tickets } = prepared;
			const plan = mode === "do" ? prepared.plans[tickets[0]!] : undefined;
			const heading = plan ? fs.readFileSync(plan, "utf8").split(/\r?\n/, 1)[0]! : "";
			const prefix = `# ${tickets[0]} — `;
			const excerpt = heading.startsWith(prefix) ? heading.slice(prefix.length) : heading;
			const admissionDisplay = coordinatorAdmissions.get(ownedRun.identity.runId);
			if (admissionDisplay) admissionDisplay.taskExcerpt = reportTaskExcerpt(excerpt || tickets.join("+"));
			if (doBinding) {
				const current = readRecordedPlanBinding(root, request.tickets[0]!);
				if (lane?.review) lane.review.store.checkCycle(ownedRun.identity.runId, current);
				else authority!.checkCycle(ownedRun.identity.runId, current);
			}
			const work = await rpc.request({ id: `${ownedRun.identity.runId}:work`, type: "prompt", message: prepared.prompt }, (response) => {
				if (response.success !== true || !lane) return;
				if (lane.review) lane.review.store.startCycle(ownedRun.identity.runId);
				if (!lane.context.startup({ state: "started", runId: ownedRun.identity.runId, facts: { model: prepared.model, cwd: prepared.cwd } })) throw new Error("coordinator startup acknowledgement lost its retained claim");
			});
			if (work.success !== true) throw new Error(`coordinator work prompt was refused: ${String(work.error ?? "unknown error")}`);
			if (ownedRun.state === "active") trackRunning(rpc.process, `${mode} ${tickets.join("+")}`, excerpt);
			return { content: [{ type: "text", text: `accepted ${ownedRun.identity.runId}, model ${prepared.model}, cwd ${prepared.cwd}` }], details: { runId: ownedRun.identity.runId, identity: ownedRun.identity } };
		} catch (error) {
			if (cleanupReservation) await cleanupReservation((error as Error).message);
			else if (!lane) activeUnits -= 1;
			throw error;
		}
	};
	const startCoordinator = async (request: CoordinatorRequest, ctx: ExtensionContext, origin: { YOKEMATE_MODE?: string; YOKEMATE_TICKET?: string; YOKEMATE_ROLE?: "coordinator" | "executor"; sessionId?: string; cwd?: string }, settings: RuntimeSettings | undefined, metadata: WorkflowConsumerMetadata = {}, workflowCaptureOverride?: WorkflowGenerationCapture, review?: { store: ReviewReworkStore; operationId: string; binding: PlanBinding }) => {
		if (!request || !["do", "ship"].includes(request.mode) || !Array.isArray(request.tickets) || !request.tickets.length) throw new Error("coordinator request needs ordered tickets");
		if (new Set(request.tickets).size !== request.tickets.length) throw new Error("ticket list contains duplicates");
		if (request.tickets.every((ticket) => !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket))) throw new Error(`invalid ticket key ${JSON.stringify(request.tickets[0])}`);
		let checks = coordinatorChecks(settings ?? readRuntimeSettings(ENGINE_ROOT));
		const caller = checks.checkCaller(origin, request);
		if (caller) throw new Error(caller);
		const workflowCapture = request.mode === "do" && !review ? workflowCaptureOverride ?? captureWorkflowGeneration() : undefined;
		if (request.mode === "do" && !review) await awaitWorkflowGeneration(workflowCapture, ctx, workflowConsumerFacts("do-list", metadata));
		if (workflowCapture) assertWorkflowCapture(workflowCapture);
		settings = readRuntimeSettings(ENGINE_ROOT);
		checks = coordinatorChecks(settings);
		const currentCaller = checks.checkCaller(origin, request);
		if (currentCaller) throw new Error(currentCaller);
		if (request.mode === "ship") {
			if (!shipPermits.consume(request.tickets, origin.sessionId ?? "main")) throw new Error("ship requires the current interactive /ship command in the main chat");
			if (checks.needsShipConfirmation(origin) && (!ctx.hasUI || !(await ctx.ui.confirm("Ship merges", "Confirm this run is on the engineer's word.")))) throw new Error("ship confirmation declined");
		}
		const bindings = new Map<string, PlanBinding>();
		const rejection = new Map<string, string>();
		for (const ticket of request.tickets) {
			if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) { rejection.set(ticket, `invalid ticket key ${JSON.stringify(ticket)}`); continue; }
			if (request.mode === "do") try {
				const binding = readRecordedPlanBinding(ENGINE_ROOT, ticket);
				if (request.plan && fs.realpathSync(path.resolve(origin.cwd ?? ENGINE_ROOT, request.plan)) !== binding.path) throw new Error("do approval --plan differs from the recorded binding");
				if (review) {
					if (request.tickets.length !== 1 || review.store.owner.ticket !== ticket) throw new Error("review rework handoff ticket mismatch");
					assertPlanBinding(review.binding, binding);
				} else {
					if (!authority || !controlIdentity) throw new Error("initial do requires a current interactive approval in its live parent");
					authority.check(ticket, binding, { ...controlIdentity, sessionId: origin.sessionId ?? "" });
				}
				bindings.set(ticket, binding);
			} catch (error) { rejection.set(ticket, (error as Error).message); }
		}
		const run = listRuns.admit({ mode: request.mode, keys: request.tickets, parentSessionId: origin.sessionId ?? "main", parentRuntimeId: controlIdentity?.runtimeId ?? "main", settings, externalActiveUnits: activeUnits - listUnits, rejectDuplicate: review ? true : checks.rejectDuplicate(request.mode), rejectKey: (key) => rejection.get(key) });
		const accepted = run.entries.filter((entry) => entry.immediate?.state === "accepted");
		if (request.mode === "do") for (const entry of accepted) {
			if (review) review.store.consume(review.operationId, entry.keyRunId, bindings.get(entry.key)!);
			else {
				authority!.consume(entry.key, bindings.get(entry.key)!, controlIdentity!, entry.keyRunId);
				authorityByCycle.set(entry.keyRunId, authority!);
			}
		}
		listUnits += accepted.length;
		activeUnits += accepted.length;
		deferredListDeliveries.add(run.identity.listRunId);
		listRuns.publishImmediate(run.identity.listRunId, true);
		setImmediate(() => {
			listRuns.start(run.identity.listRunId, async (lane) => {
				lane.signal.addEventListener("abort", () => { void cancelCoordinator(lane.keyRunId, "parent_cancel_run", true).catch(() => {}); }, { once: true });
				const part = { ...request, tickets: [lane.key] };
				const result = await startOneCoordinator(part, ctx, origin, settings, { context: lane, doBinding: bindings.get(lane.key), ...(review ? { review: { store: review.store, operationId: review.operationId } } : {}) }, { ...metadata, listRunId: lane.listRunId, keyRunId: lane.keyRunId });
				lane.active({ identity: result.details.identity, model: result.details.identity?.model, cwd: result.details.identity?.cwd });
			});
		});
		const rows = run.entries.map((entry) => ({ key: entry.key, keyRunId: entry.keyRunId, state: entry.immediate!.state, reservation: entry.immediate?.reservation, reason: entry.immediate?.reason }));
		return { content: rows.map((row) => ({ type: "text" as const, text: row.state === "accepted" ? `accepted ${row.keyRunId}, key ${row.key}, reserved` : `refused ${row.key}: ${row.reason}` })), details: { runId: accepted[0]?.keyRunId, listRunId: run.identity.listRunId, runs: accepted.map((entry) => ({ ticket: entry.key, runId: entry.keyRunId })), results: rows }, isError: accepted.length === 0 };
	};
	pi.on("session_start", async (_event, ctx) => {
		fenceOwnedGeneration("owner_replaced");
		shuttingDown = false;
		sessionGeneration += 1;
		latestCtx = ctx;
		publicationMcp.setContext(ctx);
		if (process.env.YOKEMATE_MODE === "review" && process.env.YOKEMATE_REVIEW_RUN_ID && process.env.YOKEMATE_TICKET) {
			try {
				const reply = await requestReviewControl(ENGINE_ROOT, "review-started", { ticket: process.env.YOKEMATE_TICKET, runId: process.env.YOKEMATE_REVIEW_RUN_ID }, currentControlOrigin(ENGINE_ROOT, ctx.sessionManager.getSessionId()), resolveCoordinatorParent(ENGINE_ROOT));
				if (reply.state !== "accepted") throw new Error(reply.reason ?? "review worker registration refused");
			} catch (error) { ctx.ui.notify(`automatic rework handoff unavailable: ${(error as Error).message}`, "warning"); }
		}
		if (process.env.YOKEMATE_MODE === "plan" && process.env.YOKEMATE_PLAN_RUN_ID !== undefined && process.env.YOKEMATE_TICKET) {
			try {
				if (!process.env.YOKEMATE_PLAN_RUN_ID) throw new Error("empty plan run id");
				const reply = await requestPlanControl(ENGINE_ROOT, "plan-started", { ticket: process.env.YOKEMATE_TICKET, runId: process.env.YOKEMATE_PLAN_RUN_ID }, currentControlOrigin(ENGINE_ROOT, ctx.sessionManager.getSessionId()), resolveCoordinatorParent(ENGINE_ROOT));
				if (reply.state !== "accepted") throw new Error(reply.reason ?? "plan worker registration refused");
			} catch (error) { ctx.ui.notify(`plan registration refused: ${(error as Error).message}`, "warning"); }
		}
		if (process.env.YOKEMATE_MODE || process.env.YOKEMATE_ROLE) return;
		const sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "main";
		await revokeAuthority("session_reload");
		workflowExtraction = undefined;
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		reviewReworks.clear();
		if (controlServer) await new Promise<void>((resolve) => controlServer!.close(() => resolve()));
		const runtimeId = randomUUID();
		controlIdentity = { sessionId, runtimeId };
		authority = new DoAuthorityStore(controlIdentity);
		uninstallIngress?.();
		uninstallIngress = undefined;
		if (ctx.mode === "tui" && typeof ctx.ui.getEditorComponent === "function" && typeof ctx.ui.setEditorComponent === "function") {
			uninstallIngress = installWorkflowIngress(ctx.ui, (raw) => {
				workflowExtraction?.cancel("new_input");
				auditRecoveryPreviews(breakGlassPermits.revoke(), "revoke");
				shipPermits.invalidate();
				ingressWitness = workflowIngress.submit(raw, sessionId, runtimeId);
				authority?.beginInput(raw);
			});
		}
		if (ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function") removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			const keybindings = getKeybindings();
			if (!keybindings.matches(data, "app.interrupt") && !keybindings.matches(data, "app.clear")) return;
			workflowExtraction?.cancel("interrupt");
			authority?.invalidateUnconsumed();
			shipPermits.invalidate();
			return undefined;
		});
		planRunGenerations.clear();
		planRunMetadata.clear();
		planRecordGenerations.clear();
		const prepareLocalPlanRecord = (ticket: string, candidatePath: string, expectedContentHash: string, acceptanceId: number, origin: import("../../../src/coordinator-control.ts").ControlOrigin, planRunId?: string) => {
			if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new Error("binding_changed");
			const scope = resolvePlanWriterScope(ENGINE_ROOT, ticket);
			const snapshot = readPlanWriterSnapshot(ENGINE_ROOT, scope, candidatePath);
			if (snapshot.contentHash !== expectedContentHash) throw new Error("binding_changed");
			assertPublishable(snapshot.bytes);
			const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
			try {
				const scout = publicationAcceptanceById(db, acceptanceId);
				if (!scout || scout.ticket !== ticket || scout.owner_session_id !== origin.sessionId) throw new Error("plan preparation requires its current accepted scout");
				assertPublishable(readPublicationArtifact(ENGINE_ROOT, scout));
				let writer: { runId: string; taskHash: string; actualTaskHash: string } | undefined;
				if (scout.source_kind === "engineer-accepted-input") {
					const draft = writerDraftFor(db, snapshot.contentHash);
					if (!draft || draft.accepted_input_id !== scout.id || draft.planning_identity !== scout.continuation_id || draft.plan_path !== snapshot.path || draft.bytes !== snapshot.bytes.length) throw new Error("recovery plan is not the correlated writer draft");
					const markers = ["BREAK-GLASS: engineer-accepted-input", `incident: ${scout.incident_id}`, `source-run: ${scout.source_run_id}`, `source-hash: ${scout.content_hash}`, `reason: ${scout.incident_reason}`, "skipped: failed-transport-envelope"];
					if (markers.some((marker) => !snapshot.text.includes(marker))) throw new Error("recovery plan assumptions do not match incident provenance");
					writer = { runId: draft.writer_run_id, taskHash: draft.writer_task_hash, actualTaskHash: draft.writer_actual_task_hash };
				}
				const snapshotPath = writePublicationArtifact(ENGINE_ROOT, ticket, "plan", snapshot.contentHash, snapshot.bytes);
				const record = acceptPlanRecord(db, { ticket, planPath: snapshot.path, contentHash: snapshot.contentHash, scopeHash: snapshot.scopeHash, artifactPath: snapshotPath, bytes: snapshot.bytes.length, scoutAcceptance: scout.id, ...(scout.publication_id ? { scoutPublication: scout.publication_id } : {}), ...(writer ? { writer } : {}) });
				const capture = planRunId ? planRunGenerations.get(planRunId) : !origin.mode && origin.sessionId === sessionId ? captureWorkflowGeneration() : undefined;
				if (capture && !record.successful_record && !planRecordCompletions.has(record.id) && !planRecordGenerations.has(record.id)) planRecordGenerations.set(record.id, capture);
				const binding = toPlanBinding(snapshot);
				localPreparedPlanRequests.set(record.id, { requestedPath: candidatePath, contentHash: expectedContentHash, scope, binding });
				return { binding, record, snapshotPath, scout, requestedPath: candidatePath, scope };
			} finally { db.close(); }
		};
		const publishRecordedArtifacts = async (recordId: number, binding: PlanBinding, continuation?: () => void): Promise<PublicationOutcome[]> => {
			const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
			let record;
			let scout;
			try {
				record = planRecordById(db, recordId);
				if (!record || !record.successful_record || record.ticket !== binding.ticket || record.plan_path !== binding.path || record.content_hash !== binding.contentHash || record.scope_hash !== binding.scopeHash || record.scout_acceptance === null) throw new PublicationFailure("binding_changed");
				assertPublishable(readPublicationArtifact(ENGINE_ROOT, record));
				scout = publicationAcceptanceById(db, record.scout_acceptance);
				if (!scout || scout.ticket !== binding.ticket) throw new PublicationFailure("artifact_invalid");
				assertPublishable(readPublicationArtifact(ENGINE_ROOT, scout));
			} finally { db.close(); }
			const verify = () => {
				continuation?.();
				try { assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, binding.ticket)); }
				catch { throw new PublicationFailure("binding_changed"); }
			};
			const child: ChildIdentity = { ownerRunId: scout.owner_run_id, ownerSessionId: scout.owner_session_id, batchId: scout.batch_id, runId: scout.run_id, agent: "plan-scout", taskHash: scout.task_hash, cwd: ENGINE_ROOT, ticket: binding.ticket };
			continuation?.();
			const scoutOutcome = await attemptArtifactPublication({ kind: "scout", ticket: binding.ticket, artifact: scout, runId: scout.run_id, publicationId: scout.publication_id ?? undefined, child, provenance: scout, acceptanceId: scout.id, attach: (state, row) => { acceptPublicationDelivery(state, row.id, child); }, verifyBinding: verify });
			continuation?.();
			const planOutcome: PublicationOutcome = scoutOutcome.error === "target_changed"
				? { kind: "plan", state: "pending", target: scoutOutcome.target, revision: record.content_hash, ...(record.publication_id ? { publicationId: record.publication_id } : {}), error: "target_changed" }
				: await attemptArtifactPublication({ kind: "plan", ticket: binding.ticket, artifact: record, runId: `record-${record.id}`, publicationId: record.publication_id ?? undefined, planPath: binding.path, scopeHash: binding.scopeHash, provenance: scout, acceptanceId: scout.id, attach: (state, row) => { acceptPlanRecord(state, { ticket: binding.ticket, planPath: binding.path, contentHash: binding.contentHash, scopeHash: binding.scopeHash, artifactPath: record.artifact_path, bytes: record.bytes, scoutAcceptance: scout.id, publicationId: row.id, ...(scoutOutcome.publicationId ? { scoutPublication: scoutOutcome.publicationId } : {}), ...(record.writer_run_id && record.writer_task_hash && record.writer_actual_task_hash ? { writer: { runId: record.writer_run_id, taskHash: record.writer_task_hash, actualTaskHash: record.writer_actual_task_hash } } : {}) }); }, verifyBinding: verify });
			continuation?.();
			return [scoutOutcome, planOutcome];
		};
		const completePlanRecordOnce = async (ticket: string, recordedPath: string, binding: PlanBinding, publications: PublicationOutcome[], recordId: number, context: PlanCompletionContext, verifyCompletion: (binding: PlanBinding) => void, record?: PlanRecordResult): Promise<PlanRecordCompletion> => {
			assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, ticket));
			if (fs.realpathSync(recordedPath) !== binding.path) throw new Error("plan handoff path does not match the current recorded binding");
			const planRunId = context.kind === "registered" ? context.runId : undefined;
			const found = planRunId ? listRuns.get(planRunId) : undefined;
			const recovery = planRunId ? listRuns.recovery(planRunId) : undefined;
			if (context.kind === "registered" && context.listRunId && (!found || !("run" in found) || (["refused", "recorded", "done", "blocked", "cancelled"].includes(found.entry.state) && !(found.entry.state === "blocked" && recovery?.state === "active")))) throw new Error("plan run is no longer active");
			const capture = context.kind === "save-only" ? undefined : planRecordGenerations.get(recordId) ?? (planRunId ? planRunGenerations.get(planRunId) : undefined);
			const sync = record ? { localSync: record.localSync, push: record.push } : undefined;
			if (planRunId && !recovery && listRuns.releaseLifetime(planRunId)) { listUnits = Math.max(0, listUnits - 1); activeUnits = Math.max(0, activeUnits - 1); }
			let runId: string | undefined;
			let reason = context.kind === "save-only" ? "plan-only; ready for /do; automatic handoff unavailable" : "plan-only; ready for /do; a new interactive approval is required";
			let handoff: "plan-only" | "unavailable" | "started" | "refused" = context.kind === "save-only" ? "unavailable" : "plan-only";
			const provenanceDb = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
			let recovered = false;
			let recoveryStatus: Record<string, unknown> | undefined;
			try {
				const recorded = planRecordById(provenanceDb, recordId);
				recovered = recorded?.source_kind === "engineer-accepted-input";
				if (recovered && recorded) {
					assertMandatoryBoundary("workflow.audit", Number.isSafeInteger(recorded.scout_acceptance), "recovered plan record has no accepted input");
					const accepted = publicationAcceptanceById(provenanceDb, recorded.scout_acceptance!);
					recoveryStatus = { sourceTransport: "failed", recovery: "engineer-accepted-input", candidateId: recorded.candidate_id, incidentId: recorded.incident_id, acceptedInputId: recorded.scout_acceptance, localRecord: "planned", remotePublication: publications.map((outcome) => ({ kind: outcome.kind, state: outcome.state, target: outcome.target, error: outcome.error })), sourceRunId: accepted?.source_run_id };
				}
			} finally { provenanceDb.close(); }
			if (recovered) authority!.revoke(ticket);
			let terminal: WorkflowExtractionTerminal | undefined;
			let captureCurrent = false;
			if (capture && !recovered) try {
				terminal = await awaitWorkflowGeneration(capture, ctx, workflowConsumerFacts("plan-record", planRunId ? planRunMetadata.get(planRunId) ?? { keyRunId: planRunId } : {}, ticket), false);
				assertWorkflowCapture(capture);
				captureCurrent = true;
			} catch { reason = "plan-only; workflow approval became stale; use a new /do"; }
			verifyCompletion(binding);
			assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, ticket));
			const settings = readRuntimeSettings(ENGINE_ROOT);
			if (terminal && ["timeout", "model_error", "invalid"].includes(terminal.outcome)) reason = `plan-only; workflow extraction unavailable: outcome=${terminal.outcome}; use a new /do`;
			else if (terminal?.outcome === "none") reason = "plan-only; no inferred workflow approval; use a new /do";
			if (context.kind !== "save-only" && !recovered && (!planRunId || !recorderFences.active(planRunId)) && capture && captureCurrent && terminal?.outcome === "approval" && terminal.action === "advance-plan-do") {
				const advance = capture.store.record(binding, settings.policy.workflowApproval);
				if (settings.policy.workflowApproval) reason = "plan-only; ready for /do; workflowApproval requires a new interactive approval";
				else if (advance) {
					try {
						const modelDb = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
						try {
							const model = modelForTicket(modelDb, ticket, "do") ?? poolModel(dataRoot(ENGINE_ROOT), "do");
							resolveCoordinatorModel(model, ctx.modelRegistry);
						} finally { modelDb.close(); }
						const result = await startCoordinator({ mode: "do", tickets: [ticket] }, ctx, { sessionId, cwd: ENGINE_ROOT }, settings, { keyRunId: planRunId }, capture);
						if (result.details.listRunId) setImmediate(() => flushListDelivery(result.details.listRunId));
						if (("isError" in result && result.isError) || !result.details.runId) throw new Error(result.content.map((part) => part.text).join("\n"));
						runId = result.details.runId;
						reason = "advance plan+do authority consumed";
						handoff = "started";
					} catch (error) { reason = (error as Error).message; handoff = "refused"; }
				}
			} else if (recovered) reason = "engineer-accepted-input recorded plan-only; a fresh /do approval is required";
			else if (planRunId && recorderFences.active(planRunId)) reason = "plan recorded after cancellation; automatic do handoff revoked";
			const facts = { plan: binding.path, contentHash: binding.contentHash, sync, publications, ...(recoveryStatus ? { recovery: recoveryStatus } : {}), handoff: { state: handoff, runId, reason } };
			if (planRunId && found && "run" in found) {
				const settled = recovery ? listRuns.settleRecovery(planRunId, { outcome: "recorded", facts }) : listRuns.settle(found.run.identity.listRunId, planRunId, { outcome: "recorded", facts });
				if (!settled) throw new Error("plan run lost its terminal claim");
			}
			planRecordGenerations.delete(recordId);
			if (planRunId) {
				planRunGenerations.delete(planRunId);
				planRunMetadata.delete(planRunId);
			}
			return { runId, reason, facts, publications, handoff };
		};
		const completePlanRecord = (ticket: string, recordedPath: string, binding: PlanBinding, publications: PublicationOutcome[], recordId: number, context: PlanCompletionContext, verifyCompletion: (binding: PlanBinding) => void, record?: PlanRecordResult): Promise<PlanRecordCompletion> => {
			verifyCompletion(binding);
			assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, ticket));
			const existing = planRecordCompletions.get(recordId);
			if (existing) return existing.then((outcome) => {
				verifyCompletion(binding);
				assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, ticket));
				return { ...outcome, publications, facts: { ...outcome.facts, publications } };
			});
			const completion = completePlanRecordOnce(ticket, recordedPath, binding, publications, recordId, context, verifyCompletion, record);
			planRecordCompletions.set(recordId, completion);
			void completion.catch(() => { if (planRecordCompletions.get(recordId) === completion) planRecordCompletions.delete(recordId); });
			return completion;
		};
		try {
			controlServer = bindCoordinatorControl(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), {
				reviewStarted: async (ticket, reviewRunId, reviewOrigin, surface) => {
					if (!controlIdentity || !reviewOrigin.runtimeId) throw new Error("review parent identity is unavailable");
					const existing = reviewReworks.get(reviewRunId);
					if (existing) {
						const worker = existing.store.owner.worker;
						if (worker.sessionId !== reviewOrigin.sessionId || worker.runtimeId !== reviewOrigin.runtimeId || worker.pid !== reviewOrigin.pid || worker.starttime !== reviewOrigin.starttime) throw new Error("review run cannot be revived by a new worker identity");
						return;
					}
					const store = new ReviewReworkStore({ parent: controlIdentity, reviewRunId, ticket, worker: { sessionId: reviewOrigin.sessionId, runtimeId: reviewOrigin.runtimeId, pid: reviewOrigin.pid, starttime: reviewOrigin.starttime }, surface });
					const stopObserver = observeProcessIdentity(reviewOrigin.pid, reviewOrigin.starttime, () => { void revokeReviewRun(reviewRunId, "review worker process ended before do startup"); });
					reviewReworks.set(reviewRunId, { store, stopObserver });
				},
				reviewInput: async (ticket, reviewRunId, raw) => {
					const review = reviewReworks.get(reviewRunId);
					if (!review || review.store.owner.ticket !== ticket) throw new Error("review rework store is unavailable");
					const generation = review.store.beginInput(raw);
					for (const runId of review.store.cancelPreStartCycles()) {
						listRuns.cancel(runId, "review verdict was superseded by fresh input");
						if (coordinators.get(runId)) await cancelCoordinator(runId, "parent_cancel_run", true).catch(() => {});
					}
					return generation;
				},
				reviewExtraction: async (ticket, reviewRunId, extraction, generation) => {
					const review = reviewReworks.get(reviewRunId);
					if (!review || review.store.owner.ticket !== ticket) throw new Error("review rework store is unavailable");
					const checked = validateReviewReworkExtraction(extraction, review.store.rawInput(generation), ticket);
					if (checked.kind === "rework") review.store.approveRework(generation);
					else if (checked.kind === "revoke") await revokeReviewRun(reviewRunId, "review verdict revoked before do startup", false);
				},
				reviewRecord: async (ticket, reviewRunId, candidatePath) => {
					const review = reviewReworks.get(reviewRunId);
					if (!review || review.store.owner.ticket !== ticket) throw new Error("review rework store is unavailable");
					const generation = review.store.generation();
					return review.store.claimHandoff(generation, candidatePath, async (operationId) => {
						const snapshot = readCandidatePlanSnapshot(ENGINE_ROOT, ticket, candidatePath);
						const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
						let recorded;
						try {
							const stage = (db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as { stage?: string } | undefined)?.stage;
							if (stage !== "review" && stage !== "planned") throw new Error(`${ticket} is at ${stage ?? "absent"}; review rework records only review or its owned planned retry`);
							const previousBinding = stage === "planned" ? review.store.plannedRetryBinding(operationId) : undefined;
							if (stage === "planned" && !previousBinding) throw new Error(`${ticket}: planned rework retry is not owned by this review run`);
							recorded = recordReviewRework(db, ENGINE_ROOT, ticket, snapshot.path, { YOKEMATE_MODE: "review", YOKEMATE_TICKET: ticket, YOKEMATE_ROLE: "coordinator" }, previousBinding);
						} finally { db.close(); }
						review.store.bindRecorded(operationId, recorded.binding);
						const currentStage = () => {
							const stageDb = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
							try { return String((stageDb.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as { stage?: string } | undefined)?.stage ?? "absent"); }
							finally { stageDb.close(); }
						};
						let details: { runId?: string; listRunId?: string } = {};
						try {
							if (!recorded.repeat) {
								logMove(dataRoot(ENGINE_ROOT), ticket, "на доработку", path.basename(recorded.binding.path, ".md"));
								syncPush(dataRoot(ENGINE_ROOT), `${ticket} на доработку`);
							}
							const settings = readRuntimeSettings(ENGINE_ROOT);
							const startedAt = Date.now();
							const launched = await startCoordinator({ mode: "do", tickets: [ticket], plan: recorded.binding.path }, ctx, { sessionId, cwd: ENGINE_ROOT }, settings, {}, undefined, { store: review.store, operationId, binding: recorded.binding });
							details = launched.details as { runId?: string; listRunId?: string };
							if (("isError" in launched && launched.isError) || !details.runId) throw new Error(launched.content.map((part) => part.text).join("\n") || "review do admission refused");
							if (details.listRunId) setImmediate(() => flushListDelivery(details.listRunId!));
							const remaining = Math.max(1, 120_000 - (Date.now() - startedAt));
							let timer: NodeJS.Timeout | undefined;
							let startup;
							try {
								startup = await Promise.race([
									listRuns.waitForStartup(details.runId),
									new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("review do startup timed out after 120000ms")), remaining); }),
								]);
							} catch (error) {
								listRuns.cancel(details.runId, (error as Error).message);
								if (coordinators.get(details.runId)) await cancelCoordinator(details.runId, "parent_cancel_run", true).catch(() => {});
								throw error;
							} finally { clearTimeout(timer); }
							const model = typeof startup.facts?.model === "string" ? startup.facts.model : undefined;
							if (startup.state !== "started") {
								review.store.finish(details.runId);
								return { state: startup.state === "cancelled" ? "cancelled" : "refused", recorded: true, runId: details.runId, ...(model ? { model } : {}), reason: startup.reason, stage: currentStage(), plan: recorded.binding.path, contentHash: recorded.binding.contentHash } as ReviewHandoffOutcome;
							}
							review.stopObserver();
							const close = await closeModeSurface({ ...review.store.owner.surface, cleanup() {} });
							const outcome: ReviewHandoffOutcome = { state: "started", recorded: true, runId: details.runId, ...(model ? { model } : {}), stage: currentStage(), plan: recorded.binding.path, contentHash: recorded.binding.contentHash, close };
							const started = `${ticket}: rework ${recorded.binding.path} (${recorded.binding.contentHash}) recorded; do ${details.runId} started${model ? ` with ${model}` : ""}`;
							ctx.ui.notify(close.state === "closed" ? started : `${started}; review close failed: ${close.reason}`, close.state === "closed" ? "info" : "warning");
							return outcome;
						} catch (error) {
							const outcome: ReviewHandoffOutcome = { state: "refused", recorded: true, ...(details.runId ? { runId: details.runId } : {}), reason: error instanceof Error ? error.message : String(error), stage: currentStage(), plan: recorded.binding.path, contentHash: recorded.binding.contentHash };
							ctx.ui.notify(`${ticket}: rework recorded at ${recorded.binding.path} (${recorded.binding.contentHash}), but do startup failed at ${outcome.stage}: ${outcome.reason}`, "warning");
							return outcome;
						}
					});
				},
				reviewStatus: (_ticket, reviewRunId) => reviewReworks.get(reviewRunId)?.store.outcome(),
				reviewEnded: async (_ticket, reviewRunId, reason) => { await revokeReviewRun(reviewRunId, reason); },
				publishPlanScout: async (ticket, acceptanceId, child, origin) => {
					const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
					let acceptance;
					try {
						acceptance = publicationAcceptanceById(db, acceptanceId);
						if (!acceptance || acceptance.ticket !== ticket || acceptance.owner_run_id !== child.ownerRunId || acceptance.owner_session_id !== child.ownerSessionId || acceptance.batch_id !== child.batchId || acceptance.run_id !== child.runId || acceptance.task_hash !== child.taskHash || child.agent !== "plan-scout" || child.ticket !== ticket || path.resolve(child.cwd) !== path.resolve(ENGINE_ROOT) || child.ownerSessionId !== origin.sessionId) throw new Error("accepted scout identity does not match its delivery");
						assertPublishable(readPublicationArtifact(ENGINE_ROOT, acceptance));
					} finally { db.close(); }
					const outcome = await attemptArtifactPublication({ kind: "scout", ticket, artifact: acceptance, runId: acceptance.run_id, publicationId: acceptance.publication_id ?? undefined, child, provenance: acceptance, acceptanceId: acceptance.id, attach: (state, row) => { acceptPublicationDelivery(state, row.id, child); } });
					return { reason: outcome.state === "complete" ? "scout publication complete" : outcome.error ?? "unavailable", publication: outcome.state, target: outcome.target, revision: outcome.revision, publicationId: outcome.publicationId };
				},
				planRegistered: (_ticket, planRunId, _origin, dispatch) => {
					const capture = captureWorkflowGeneration();
					if (capture && !planRunGenerations.has(planRunId)) planRunGenerations.set(planRunId, capture);
					planRunMetadata.set(planRunId, { ...dispatch, keyRunId: planRunId });
				},
				preparePlanPublication: async (ticket, candidatePath, contentHash, acceptanceId, origin, context) => {
					const prepared = prepareLocalPlanRecord(ticket, candidatePath, contentHash, acceptanceId, origin, context.kind === "registered" ? context.runId : undefined);
					return { reason: "local plan record prepared", recordId: prepared.record.id, snapshotPath: prepared.snapshotPath, scoutAcceptance: prepared.scout.id, revision: prepared.binding.contentHash, binding: prepared.binding, ...(prepared.record.publication_id ? { publicationId: prepared.record.publication_id } : {}), ...(prepared.record.scout_publication ? { scoutPublication: prepared.record.scout_publication } : {}) };
				},
				planRecorded: async (ticket, recordedPath, recordId, _origin, context, verifyCompletion, prior, contentHash) => {
					const request = localPreparedPlanRequests.get(recordId);
					if (!request || request.requestedPath !== recordedPath || request.contentHash !== contentHash) throw new Error("binding_changed");
					assertPlanBinding(request.binding, readPlanWriterSnapshot(ENGINE_ROOT, request.scope, request.requestedPath));
					const binding = readRecordedPlanBinding(ENGINE_ROOT, ticket);
					if (fs.realpathSync(recordedPath) !== binding.path || binding.contentHash !== contentHash) throw new Error("binding_changed");
					const continuation = () => verifyCompletion(binding);
					continuation();
					const publications = await publishRecordedArtifacts(recordId, binding, continuation);
					try { assertPlanBinding(binding, readRecordedPlanBinding(ENGINE_ROOT, ticket)); }
					catch { throw new Error("binding_changed"); }
					verifyCompletion(binding);
					assertPlanBinding(request.binding, readPlanWriterSnapshot(ENGINE_ROOT, request.scope, request.requestedPath));
					if (prior) return { ...prior, publications, ...(prior.facts ? { facts: { ...prior.facts, publications } } : {}) };
					return completePlanRecord(ticket, recordedPath, binding, publications, recordId, context, verifyCompletion);
				},
				launchPlan: async (request, controlOrigin, dispatch) => {
					const launchCapture = captureWorkflowGeneration();
					const settings = readRuntimeSettings(ENGINE_ROOT);
					const run = listRuns.admit({ mode: "plan", keys: request.targets.map((target) => target.ticket), parentSessionId: sessionId, parentRuntimeId: runtimeId, settings, externalActiveUnits: activeUnits - listUnits, rejectDuplicate: settings.policy.guards.duplicateMode, rejectKey: (key) => /^[A-Z][A-Z0-9]*-\d+$/.test(key) ? undefined : `invalid ticket key ${JSON.stringify(key)}` });
					const accepted = run.entries.filter((entry) => entry.immediate?.state === "accepted");
					for (const entry of accepted) {
						if (launchCapture) planRunGenerations.set(entry.keyRunId, launchCapture);
						planRunMetadata.set(entry.keyRunId, { ...dispatch, listRunId: run.identity.listRunId, keyRunId: entry.keyRunId });
					}
					listUnits += accepted.length;
					activeUnits += accepted.length;
					setImmediate(() => {
						listRuns.start(run.identity.listRunId, async (key) => {
							const target = request.targets[key.index]!;
							const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
							let model: string;
							try { model = request.model ?? modelForTicket(db, key.key, "plan") ?? poolModel(dataRoot(ENGINE_ROOT), "plan"); }
							finally { db.close(); }
							const facts = await launchPlanKey(ENGINE_ROOT, request, target, key.keyRunId, model, async (pane) => {
								const reply = await requestPlanControl(ENGINE_ROOT, "bind-plan", { ticket: key.key, runId: key.keyRunId, pane }, currentControlOrigin(ctx.cwd, controlOrigin.sessionId), controlIdentity!);
								if (reply.state !== "accepted") throw new Error(reply.reason ?? "plan pane binding refused");
							});
							key.active({ ...facts });
						});
						listRuns.publishImmediate(run.identity.listRunId);
					});
					return { listRunId: run.identity.listRunId, results: run.entries.map((entry) => ({ key: entry.key, keyRunId: entry.keyRunId, state: entry.immediate!.state, reservation: entry.immediate?.reservation, reason: entry.immediate?.reason })) };
				},
				planFinished: async (_ticket, context, outcome, reason) => {
					if (context.kind !== "registered") return;
					const planRunId = context.runId;
					planRunGenerations.delete(planRunId);
					planRunMetadata.delete(planRunId);
					if (recordingPlans.has(planRunId)) {
						recorderFences.fence(planRunId, false);
						recorderControllers.get(planRunId)?.abort();
					}
					if (!context.listRunId) return;
					const found = listRuns.get(planRunId);
					if (!found || !("run" in found)) throw new Error("plan run is no longer active");
					if (!listRuns.settle(found.run.identity.listRunId, planRunId, { outcome, reason })) throw new Error("plan run is no longer active");
					planRunGenerations.delete(planRunId);
					planRunMetadata.delete(planRunId);
				},
				recordPlan: async (ticket, planPath, origin, context, acceptanceId, verifyCompletion, contentHash) => {
					if (context.kind !== "registered") throw new Error("owned plan record requires a registered run");
					const planRunId = context.runId;
					const controller = new AbortController();
					const generation = sessionGeneration;
					let resolveCompletion!: () => void;
					const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
					recorderCompletions.set(planRunId, completion);
					recordingPlans.add(planRunId);
					recorderControllers.set(planRunId, controller);
					let locallyRecorded = false;
					try {
						const prepared = prepareLocalPlanRecord(ticket, planPath, contentHash, acceptanceId, origin, planRunId);
						const result = await recordPlanFile(ENGINE_ROOT, ticket, planPath, process.env, { expectedBinding: prepared.binding, expectedContentHash: contentHash, requestedPath: prepared.requestedPath, scope: prepared.scope, recordId: prepared.record.id, signal: controller.signal, onLocked: () => lockedRecordingPlans.add(planRunId) });
						locallyRecorded = true;
						const continuation = () => {
							if (recorderFences.active(planRunId) || generation !== sessionGeneration) throw new Error("plan recorder cancelled before publication and handoff");
						};
						continuation();
						if (result.localSync.state === "deferred" || result.localSync.state === "error") ctx.ui.notify(`git-sync: ${result.localSync.reason}`, "warning");
						const pushed = result.push;
						if (pushed?.state === "deferred" || pushed?.state === "error") ctx.ui.notify(`git-sync: ${pushed.reason}`, "warning");
						const publications = await publishRecordedArtifacts(prepared.record.id, prepared.binding, continuation);
						try { assertPlanBinding(prepared.binding, readRecordedPlanBinding(ENGINE_ROOT, ticket)); }
						catch { throw new PublicationFailure("binding_changed"); }
						verifyCompletion(prepared.binding);
						return await completePlanRecord(ticket, result.plan, prepared.binding, publications, prepared.record.id, context, verifyCompletion, result);
					} catch (error) {
						if (controller.signal.aborted && !lockedRecordingPlans.has(planRunId)) {
							const found = listRuns.get(planRunId);
							if (found && "run" in found) listRuns.settle(found.run.identity.listRunId, planRunId, { outcome: "cancelled", reason: "plan recorder cancelled before lock acquisition" });
						}
						if (locallyRecorded) {
							const reason = error instanceof PublicationFailure ? error.code : error instanceof Error && /approval .* changed|binding_changed/.test(error.message) ? "binding_changed" : (error as Error).message;
							throw new Error(`${ticket} locally recorded; ${reason}`);
						}
						throw error;
					} finally {
						recordingPlans.delete(planRunId);
						lockedRecordingPlans.delete(planRunId);
						recorderControllers.delete(planRunId);
						const fence = recorderFences.consume(planRunId);
						if (fence.fenced) {
							const found = listRuns.get(planRunId);
							const agentName = found && "run" in found && typeof found.entry.immediate?.facts?.agentName === "string" ? found.entry.immediate.facts.agentName : undefined;
							listRuns.cancel(planRunId, "plan recorder cancelled before publication and handoff");
							if (fence.stopAgent && agentName) void herdrAsync(["agent", "stop", agentName]).catch(() => {});
						}
						resolveCompletion();
						recorderCompletions.delete(planRunId);
					}
				},
				launch: async (request, controlOrigin, dispatch) => {
					const origin = { YOKEMATE_MODE: controlOrigin.mode, YOKEMATE_TICKET: controlOrigin.ticket, YOKEMATE_ROLE: controlOrigin.role as "coordinator" | "executor" | undefined, sessionId: controlOrigin.sessionId, cwd: controlOrigin.cwd };
					const result = await startCoordinator(request, ctx, origin, undefined, dispatch);
					const details = result.details as { runId?: string; listRunId?: string; results?: import("../../../src/coordinator-control.ts").ControlResult[] };
					return { ...details, afterAck: () => details.listRunId && flushListDelivery(details.listRunId) };
				},
				status: (requestId, _origin) => {
					const run = coordinators.get(requestId);
					if (run) return { requestId, state: "status", runId: requestId, identity: run.identity, reason: run.state };
					const list = listRuns.get(requestId);
					return list ? { requestId, state: "status", runId: requestId, identity: list, reason: "list" } : { requestId, state: "refused", reason: "unknown coordinator request" };
				},
				cancel: async (runId, _origin) => {
					const target = listRuns.get(runId);
					const direct = coordinators.get(runId);
					if (target || direct) {
						workflowExtraction?.cancel("parent_cancel");
						shipPermits.invalidate();
					}
					if (target) {
						const entries = "run" in target ? [target.entry] : target.entries;
						const recording = entries.filter((entry) => upgradeRecordingFence(entry.keyRunId));
						const active = entries.filter((entry) => (!["refused", "recorded", "done", "blocked", "cancelled"].includes(entry.state) || listRuns.recovery(entry.keyRunId)?.state === "active"));
						if (!active.length) return cancellationResult(runId, "list", recording.length ? "cancellation_requested" : "already_terminal", recording.length === 0);
						let pending = recording.length > 0;
						const fenced = fenceTargetedWorkflow(entries.map((entry) => entry.key), active.map((entry) => entry.keyRunId), "parent control cancel");
						await Promise.all(fenced.coordinatorRunIds.map((id) => cancelCoordinator(id, "parent_control_cancel", true)));
						for (const entry of active) {
							if (upgradeRecordingFence(entry.keyRunId)) {
								for (const coordinatorRunId of authority?.revoke(entry.key) ?? []) await cancelCoordinator(coordinatorRunId, "parent_cancel_run");
								pending = true;
								continue;
							}
							const agentName = typeof entry.immediate?.facts?.agentName === "string" ? entry.immediate.facts.agentName : undefined;
							listRuns.cancel(entry.keyRunId);
							if (coordinators.get(entry.keyRunId)) await cancelCoordinator(entry.keyRunId, "parent_control_cancel", true);
							if (agentName) await herdrAsync(["agent", "stop", agentName]).catch(() => {});
						}
						return cancellationResult(runId, "list", pending ? "cancellation_requested" : "cancelled", !pending);
					}
					const coordinator = coordinators.get(runId);
					if (!coordinator) return cancellationResult(runId, "unknown", "unknown", false);
					if (["done", "blocked"].includes(coordinator.state)) return cancellationResult(runId, "coordinator", "already_terminal", true);
					const fenced = fenceTargetedWorkflow([coordinator.identity.ticket], [runId], "parent control cancel");
					await Promise.all(fenced.coordinatorRunIds.map((id) => cancelCoordinator(id, "parent_control_cancel")));
					return cancellationResult(runId, "coordinator", "cancelled", true);
				},
				merge: async (runId, request, mergeOrigin) => {
					const run = coordinators.get(runId);
					const rpc = rpcByRun.get(runId);
					if (!run || run.identity.mode !== "ship" || run.state !== "active" || !run.prepared || !rpc?.process.pid) throw new Error("ship coordinator run is not active");
					if (mergeOrigin.pid !== rpc.process.pid || mergeOrigin.starttime !== processStarttime(rpc.process.pid)) throw new Error("merge origin is not the owned coordinator process");
					const parts = run.prepared.parts.filter((part) => part.pr === request.pr);
					if (parts.length !== 1) throw new Error("merge PR is outside the prepared coordinator scope");
					return coordinatorMerge({ root: ENGINE_ROOT, runId, ticket: run.identity.ticket, part: parts[0]!, live: () => coordinators.get(runId)?.state === "active" && rpcByRun.get(runId)?.process === rpc.process }, request);
				},
				finalizeShip: async (runId, finalizeOrigin) => {
					const run = coordinators.get(runId);
					const rpc = rpcByRun.get(runId);
					if (!run || run.identity.mode !== "ship" || run.state !== "active" || !run.prepared || !rpc?.process.pid) throw new Error("ship coordinator run is not active");
					if (finalizeOrigin.pid !== rpc.process.pid || finalizeOrigin.starttime !== processStarttime(rpc.process.pid)) throw new Error("ship finalization origin is not the owned coordinator process");
					const merged = verifyPreparedShipMerged(ENGINE_ROOT, run.prepared);
					if (!merged.ok) throw new Error(merged.reason ?? "not every prepared PR is merged");
					return finalizeShip(ENGINE_ROOT, run.identity.ticket);
				},
			}, { root: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."), sessionId, runtimeId, pid: process.pid, starttime: processStarttime(process.pid) ?? "", cwd: ctx.cwd, pane: process.env.HERDR_PANE_ID });
		} catch (error) { ctx.ui.notify(`coordinator control is not up: ${(error as Error).message}`, "warning"); }
	});
	pi.registerCommand("break-glass", {
		description: "Accept one exact failed plan-scout transport input through an audited incident.",
		handler: async (args, ctx) => {
			let state: DatabaseSync | undefined;
			let preview: BreakGlassPreview | undefined;
			let decision: { candidateId: string; ticket: string; reason: string; inputHash: string } | undefined;
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				if (ctx.mode !== "tui" || process.env.YOKEMATE_MODE || process.env.YOKEMATE_ROLE || !controlIdentity || controlIdentity.sessionId !== sessionId || !ingressWitness) throw new Error("break-glass requires a fresh typed submit in verified MAIN TUI");
				const raw = `/break-glass${args ? ` ${args}` : ""}`;
				if (ingressWitness.raw !== raw || ingressWitness.runtimeId !== controlIdentity.runtimeId) throw new Error("break-glass requires the current exact typed submit");
				const command = parseBreakGlass(raw);
				decision = { candidateId: command.candidateId, ticket: command.ticket, reason: command.reason, inputHash: ingressWitness.hash };
				state = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				const candidate = state.prepare("SELECT * FROM plan_scout_candidate WHERE id=?").get(command.candidateId) as any;
				if (!candidate || candidate.ticket !== command.ticket) throw new Error("unknown recovery candidate");
				const parent = resolveCoordinatorParent(ENGINE_ROOT);
				const mainOrigin = currentControlOrigin(ENGINE_ROOT, sessionId);
				const live = await requestPlanControl(ENGINE_ROOT, "read-scout-candidate", { ticket: command.ticket, runId: candidate.planning_identity, candidateId: command.candidateId }, mainOrigin, parent);
				if (live.state !== "accepted" || live.failureHash !== candidate.failed_envelope_hash) throw new Error(live.reason ?? "recovery lineage is not live");
				const snapshot = (): { scopeHash: string; targetHash: string; plan: PlanSnapshotIdentity } => {
					const target = resolvePublicationTarget(state!, command.ticket);
					const recorded = state!.prepare("SELECT plan FROM work WHERE ticket=?").get(command.ticket) as { plan?: string | null } | undefined;
					if (recorded?.plan) {
						const binding = readRecordedPlanBinding(ENGINE_ROOT, command.ticket);
						return { scopeHash: binding.scopeHash, targetHash: target.targetHash, plan: { state: "recorded", hash: binding.contentHash, scopeHash: binding.scopeHash, pathHash: sha256(binding.path) } };
					}
					const absent = sha256(JSON.stringify([command.ticket, target.targetHash, candidate.content_hash, "plan-absent"]));
					return { scopeHash: absent, targetHash: target.targetHash, plan: { state: "absent", hash: sha256("absent"), scopeHash: absent, pathHash: sha256("absent") } };
				};
				const initial = snapshot();
				preview = previewScoutAcceptance({ db: state, root: ENGINE_ROOT, command, witness: ingressWitness, planningRunId: candidate.planning_identity, liveFailureHash: candidate.failed_envelope_hash, ...initial, store: breakGlassPermits });
				const currentPreview = preview;
				const recheck = async (): Promise<Omit<BreakGlassPreview, "permitId" | "createdAt" | "expiresAt">> => {
					const currentLive = await requestPlanControl(ENGINE_ROOT, "read-scout-candidate", { ticket: command.ticket, runId: candidate.planning_identity, candidateId: command.candidateId }, mainOrigin, parent);
					if (currentLive.state !== "accepted" || currentLive.failureHash !== currentPreview.failureHash) throw new Error(currentLive.reason ?? "recovery lineage changed");
					const currentCandidate = state!.prepare("SELECT * FROM plan_scout_candidate WHERE id=?").get(command.candidateId) as any;
					if (!currentCandidate || currentCandidate.content_hash !== currentPreview.candidateHash || currentCandidate.bytes !== currentPreview.candidateBytes || currentCandidate.failed_envelope_hash !== currentPreview.failureHash) throw new Error("recovery candidate changed");
					const current = snapshot();
					const { permitId: _permitId, createdAt: _createdAt, expiresAt: _expiresAt, ...expected } = currentPreview;
					return { ...expected, ...current, plan: { ...current.plan }, bypassed: [...expected.bypassed] as ["plan.scout.transport-input"], preserved: [...expected.preserved], blockers: [] };
				};
				const accepted = await resolveScoutAcceptance({
					db: state, root: ENGINE_ROOT, store: breakGlassPermits, preview: currentPreview, witness: ingressWitness, sourceUid: process.getuid!(),
					confirm: async (value) => ctx.hasUI && await ctx.ui.confirm("Audited break-glass", `${value.ticket} accepts candidate ${value.candidateId}\nsource-run: ${value.sourceRunId}\nbytes: ${value.candidateBytes}\npayload-hash: ${value.candidateHash}\nfailure-category: failed-transport-envelope\nfailure-hash: ${value.failureHash}\nreason: ${value.reason}\nstatus: pending engineer confirmation\nresult: plan-only; /do still needs fresh approval`, { timeout: Math.max(1, value.expiresAt - Date.now()) }),
					recheck,
					continueLineage: async () => {
						const continued = await requestPlanControl(ENGINE_ROOT, "continue-scout-candidate", { ticket: command.ticket, runId: candidate.planning_identity, candidateId: command.candidateId, failureHash: candidate.failed_envelope_hash }, mainOrigin, parent);
						if (continued.state !== "accepted" || !continued.planningIdentity || typeof continued.generation !== "number" || !continued.generation) throw new Error(continued.reason ?? "recovery continuation refused");
						const recovery = listRuns.admitRecovery(candidate.planning_identity, continued.generation);
						if (recovery.recoveryRunId !== continued.planningIdentity) throw new Error("recovery list identity changed");
						return { planningIdentity: continued.planningIdentity, generation: continued.generation };
					},
				});
				const bound = await requestPlanControl(ENGINE_ROOT, "bind-recovered-scout", { ticket: command.ticket, runId: candidate.planning_identity, candidateId: command.candidateId, failureHash: candidate.failed_envelope_hash, acceptanceId: accepted.acceptance.id }, mainOrigin, parent);
				if (bound.state !== "accepted") throw new Error(bound.reason ?? "recovered scout binding refused");
				workflowIngress.consume(ingressWitness.id, sessionId, controlIdentity.runtimeId, raw);
				ingressWitness = undefined;
				ctx.ui.notify(`${command.ticket}: incident ${accepted.incidentId}; accepted-input ${accepted.acceptance.id}; source-run ${candidate.run_id}; failure failed-transport-envelope ${candidate.failed_envelope_hash}; status accepted as ${accepted.planningIdentity}; result remains plan-only`, "warning");
			} catch (error) {
				const message = (error as Error).message;
				const outcome = /expired/i.test(message) ? "expiry" : "refusal";
				try {
					auditRecoveryPreviews(breakGlassPermits.revoke(), outcome);
					if (decision && controlIdentity) {
						const audit = state ?? openDb(path.join(ENGINE_ROOT, "yokemate.db"));
						const code = /unknown recovery candidate|candidate.*(?:changed|stale)/i.test(message) ? "candidate-unavailable"
							: /lineage|live/i.test(message) ? "lineage-unavailable"
							: /target|plan|scope|binding/i.test(message) ? "snapshot-invalid"
							: /declined/i.test(message) ? "engineer-declined"
							: outcome === "expiry" ? "permit-expired" : "recovery-refused";
						appendRecoveryDecision(audit, { ...decision, action: "accept-plan-scout-input", sourceUid: process.getuid!(), sourceSessionId: controlIdentity.sessionId, sourceRuntimeId: controlIdentity.runtimeId, code, blockers: [code], outcome, reason: decision.reason });
						if (!state) audit.close();
					}
				} catch (auditError) { ctx.ui.notify(`break-glass audit failed: ${(auditError as Error).message}`, "error"); }
				ctx.ui.notify(`break-glass refused: ${message}`, "error");
			} finally { state?.close(); }
		},
	});

	pi.registerCommand("yokemate-coordinator-ready", {
		description: "Initialize an owned coordinator RPC runtime.",
		handler: async (args, ctx) => {
			try {
				const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8")) as { identity?: { runId?: string; role?: string; cwd?: string }; prepared?: { cwd?: string; plan?: string; diagnosticRoot?: string; doBinding?: PlanBinding } };
				const identity = payload.identity;
				if (!identity || identity.role !== "coordinator" || identity.runId !== process.env.YOKEMATE_RUN_ID || identity.cwd !== ctx.cwd || payload.prepared?.cwd !== ctx.cwd || !ctx.isProjectTrusted()) throw new Error("invalid coordinator ready identity");
				const commands = pi.getCommands().map((command) => command.name);
				if (!commands.includes(`skill:${process.env.YOKEMATE_MODE}-worker`)) throw new Error("worker skill unavailable");
				if (payload.prepared?.doBinding) {
					assertPlanBinding(payload.prepared.doBinding, readRecordedPlanBinding(ENGINE_ROOT, payload.prepared.doBinding.ticket));
					ownedBinding = payload.prepared.doBinding;
				}
				fenceOwnedGeneration("owner_replaced");
				runs = new ChildRuns(identity.runId!, ctx.sessionManager.getSessionId());
				ownedReadyRunId = identity.runId;
				ownedGeneration = { serial: sessionGeneration, ownerRunId: identity.runId!, ownerSessionId: runs.ownerSessionId, runs, fenced: false, producerObligations: 0, batchDispatches: 0, failureProduced: 0, failureConsumed: 0, revision: 0, listeners: new Set() };
				ownedGenerations.set(ownedGenerationKey(identity.runId!, runs.ownerSessionId), ownedGeneration);
				emitChildState();
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
				const entry = deliveries.get(id);
				if (!entry || entry.delivery.state === "observed" || entry.delivery.state === "delivery_failed") continue;
				entry.delivery.state = "delivery_unknown";
				for (const runId of entry.delivery.runIds) {
					const diagnostic = diagnostics.get(runId);
					if (!diagnostic) continue;
					const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
					states[id] = { state: entry.delivery.state, envelopeHash: entry.delivery.envelopeHash, failedAt: new Date().toISOString() };
					diagnostic.metadata.deliveries = states;
					diagnostic.save(true);
				}
				const retained = reportArchives.get(id);
				if (retained) retained.facts = archiveFacts(entry.envelope, entry.delivery);
				updateReportArchive(id);
			}
			emitChildState();
		},
	});
	pi.registerCommand("yokemate-child-cancel", {
		description: "Record an owned parent cancellation before teardown.",
		handler: async (args, ctx) => {
			const payload = JSON.parse(Buffer.from(args.trim(), "base64").toString("utf8"));
			if (payload.runId !== ownedReadyRunId || !["parent_rpc_stop", "parent_control_cancel", "parent_cancel_run", "parent_session_shutdown"].includes(payload.reason)) throw new Error("invalid owned child cancellation");
			const sessionId = ctx.sessionManager.getSessionId();
			fenceOwnedGeneration(payload.reason);
			await Promise.all((runs?.active() ?? []).map((child) => requestOrdinaryCancellation(child.identity.runId, payload.reason, payload.runId, sessionId)));
		},
	});
	pi.on("session_shutdown", async (event) => {
		fenceOwnedGeneration("parent_shutdown");
		shuttingDown = true;
		const revoked = revokeAuthority(event.reason === "reload" ? "session_reload" : event.reason === "fork" ? "session_fork" : "session_shutdown");
		workflowExtraction = undefined;
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		sessionGeneration += 1;
		const sessionId = latestCtx?.sessionManager?.getSessionId?.();
		const ordinaryStops = sessionId && runs ? runs.shutdownActive().map((child) => requestOrdinaryCancellation(child.identity.runId, "session_shutdown", runs!.ownerRunId, sessionId)) : [];
		uninstallIngress?.();
		uninstallIngress = undefined;
		auditRecoveryPreviews(breakGlassPermits.revoke(), "revoke");
		workflowIngress.revoke();
		ingressWitness = undefined;
		try { await endOwnedReview("review session shutdown"); }
		catch (error) { latestCtx?.ui.notify(`review shutdown fencing failed: ${(error as Error).message}`, "error"); }
		await Promise.all([...reviewReworks.keys()].map((runId) => revokeReviewRun(runId, "parent session shutdown")));
		for (const { delivery, envelope } of deliveries.values()) {
			if (!["pending", "enqueued"].includes(delivery.state)) continue;
			delivery.state = "delivery_unknown";
			delivery.code = "parent_shutdown";
			delivery.failedAt = new Date().toISOString();
			for (const runId of delivery.runIds) {
				const diagnostic = diagnostics.get(runId);
				if (!diagnostic) continue;
				const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
				states[delivery.deliveryId] = { state: delivery.state, envelopeHash: delivery.envelopeHash, failedAt: delivery.failedAt, code: delivery.code };
				diagnostic.metadata.deliveries = states;
				diagnostic.save(true);
			}
			const retained = reportArchives.get(delivery.deliveryId);
			if (retained) retained.facts = archiveFacts(envelope, delivery);
			updateReportArchive(delivery.deliveryId);
		}
		emitChildState();
		await revoked;
		await Promise.all([...recorderCompletions.values()]);
		authority?.revoke();
		authority = undefined;
		shipPermits.invalidate();
		controlServer?.close();
		controlServer = undefined;
		controlIdentity = undefined;
		reviewReworks.clear();
		await publicationMcp.shutdown();
		for (const controller of uiAbortByRun.values()) controller.abort();
		uiAbortByRun.clear();
		for (const runId of coordinatorUnits) releaseCoordinatorUnit(runId);
		coordinatorAdmissions.clear();
		const coordinatorStops = [...rpcByRun.values()].map((rpc) => rpc.stop("parent_session_shutdown"));
		rpcByRun.clear();
		coordinatorChildren.clear();
		await Promise.all(ordinaryStops);
		await Promise.all([...batchCompletions.values()].map((completion) => completion.promise));
		await Promise.all((runs?.active() ?? []).map((child) => runs!.finalized(child.identity)));
		await Promise.all(coordinatorStops);
		detached.clear();
		ordinaryProcesses.clear();
		batches.clear();
		batchModes.clear();
		batchCompletions.clear();
		sentBatches.clear();
		deliveries.clear();
		diagnostics.clear();
		recorderFences.clear();
		ownedGeneration = undefined;
		ownedReadyRunId = undefined;
		runs = undefined;
		runningAgents.clear();
		stopWidgetTimer();
		renderRunningWidget();
	});

	pi.on("turn_start", (_event, ctx) => {
		latestCtx = ctx;
		const signal = ctx.signal;
		const capture = captureWorkflowGeneration();
		if (signal && capture && !observedTurnSignals.has(signal)) {
			observedTurnSignals.add(signal);
			signal.addEventListener("abort", () => {
				if (!capture.operation?.matches(capture.parent, capture.store)) return;
				capture.operation.cancel("interrupt");
				if (authority === capture.store) capture.store.invalidateUnconsumed();
				shipPermits.invalidate();
			}, { once: true });
		}
		renderRunningWidget();
	});

	const fenceOwnedGeneration = (code: string): void => {
		const generation = ownedGeneration;
		if (!generation || generation.fenced) return;
		generation.fenced = true;
		for (const entry of deliveries.values()) {
			if (entry.generation !== generation || !["pending", "enqueued"].includes(entry.delivery.state)) continue;
			entry.delivery.state = "delivery_unknown";
			entry.delivery.code = code;
			entry.delivery.failedAt = new Date().toISOString();
			for (const runId of entry.delivery.runIds) {
				const diagnostic = diagnostics.get(runId);
				if (!diagnostic) continue;
				const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
				states[entry.delivery.deliveryId] = { state: entry.delivery.state, envelopeHash: entry.delivery.envelopeHash, failedAt: entry.delivery.failedAt, code };
				diagnostic.metadata.deliveries = states;
				diagnostic.save(true);
			}
			const retained = reportArchives.get(entry.delivery.deliveryId);
			if (retained) retained.facts = archiveFacts(entry.envelope, entry.delivery);
			updateReportArchive(entry.delivery.deliveryId);
		}
		wakeOwnedGeneration(generation, true);
		emitChildState();
	};
	pi.on("turn_end", async (_event, ctx) => {
		const generation = currentOwnedGeneration();
		if (!generation) return;
		for (;;) {
			if (generation !== ownedGeneration || generation.fenced || shuttingDown || ctx.signal?.aborted) return;
			if ([...deliveries.values()].some((entry) => entry.generation === generation && entry.delivery.state === "enqueued")) return;
			if (generation.failureConsumed < generation.failureProduced) {
				generation.failureConsumed += 1;
				return;
			}
			if (!generation.runs.active().length && generation.producerObligations === 0 && generation.batchDispatches === 0) return;
			const revision = generation.revision;
			await new Promise<void>((resolve) => {
				let finished = false;
				const finish = () => {
					if (finished) return;
					finished = true;
					generation.listeners.delete(finish);
					ctx.signal?.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => { fenceOwnedGeneration("turn_abort"); finish(); };
				generation.listeners.add(finish);
				ctx.signal?.addEventListener("abort", abort, { once: true });
				if (generation.revision !== revision || generation !== ownedGeneration || generation.fenced || ctx.signal?.aborted || [...deliveries.values()].some((entry) => entry.generation === generation && entry.delivery.state === "enqueued") || generation.failureConsumed < generation.failureProduced || (!generation.runs.active().length && generation.producerObligations === 0 && generation.batchDispatches === 0)) finish();
			});
		}
	});

	const registerDelivery = (envelope: ReportEnvelope) => {
		const delivery = deliveryFor(envelope);
		if (!deliveries.has(delivery.deliveryId)) deliveries.set(delivery.deliveryId, { delivery, envelope, generation: ownedGenerationFor(envelope) });
		return deliveries.get(delivery.deliveryId)!;
	};
	const failDelivery = (deliveryId: string, code: string): void => {
		const entry = deliveries.get(deliveryId);
		if (!entry || entry.delivery.state === "observed" || ["delivery_failed", "delivery_unknown"].includes(entry.delivery.state)) return;
		entry.delivery.state = "delivery_failed";
		entry.delivery.code = code;
		entry.delivery.failedAt = new Date().toISOString();
		for (const runId of entry.delivery.runIds) {
			const diagnostic = diagnostics.get(runId);
			if (!diagnostic) continue;
			const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
			states[deliveryId] = { state: entry.delivery.state, envelopeHash: entry.delivery.envelopeHash, failedAt: entry.delivery.failedAt, code };
			diagnostic.metadata.deliveries = states;
			diagnostic.save(true);
		}
		const retained = reportArchives.get(deliveryId);
		if (retained) retained.facts = archiveFacts(entry.envelope, entry.delivery);
		updateReportArchive(deliveryId);
		if (entry.generation) wakeOwnedGeneration(entry.generation, true);
		emitChildState();
	};
	const sendReport = (envelope: ReportEnvelope): void => {
		const entry = registerDelivery(envelope);
		const { delivery, generation } = entry;
		if (delivery.state !== "pending") return;
		try {
			const canonical = reportContent(envelope, delivery);
			const factsByRun = new Map((envelope.kind === "result" ? [envelope] : envelope.results).map((result) => [result.identity.runId, diagnosticFacts(result.identity.runId)]));
			const facts = archiveFacts(envelope, delivery);
			const stored = reportStore.writeReport(delivery.deliveryId, canonical, facts);
			reportArchives.set(delivery.deliveryId, { facts });
			const diagnosticCode = delivery.runIds.map((runId) => diagnostics.get(runId)?.metadata.displayDiagnostic).find((value): value is string => typeof value === "string");
			const display = reportDisplays.get(delivery.deliveryId) ?? buildReportDisplay(envelope, reportAdmissions, reportSettledAt, stored.archive, factsByRun, diagnosticCode);
			reportDisplays.set(delivery.deliveryId, display);
			emitChildState();
			if (shuttingDown || generation?.fenced || (generation && generation !== ownedGeneration)) {
				delivery.state = "delivery_unknown";
				delivery.code = "owner_fenced";
				delivery.failedAt = new Date().toISOString();
				if (generation) wakeOwnedGeneration(generation, true);
			} else {
				pi.sendMessage({ customType: "subagent-report", content: canonical, display: true, details: { version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope, display } }, { deliverAs: generation ? "steer" : "followUp", triggerTurn: true, yokemateSendId: delivery.deliveryId, onYokemateSendError: (sendId) => failDelivery(sendId, "send_rejected") });
				if (delivery.state === "pending") {
					delivery.state = "enqueued";
					if (generation) wakeOwnedGeneration(generation);
				}
			}
		} catch { failDelivery(delivery.deliveryId, "send_throw"); }
		for (const runId of delivery.runIds) {
			const diagnostic = diagnostics.get(runId);
			if (diagnostic) {
				const states = (diagnostic.metadata.deliveries ?? {}) as Record<string, unknown>;
				states[delivery.deliveryId] = { state: delivery.state, envelopeHash: delivery.envelopeHash, ...(delivery.state === "enqueued" ? { enqueuedAt: new Date().toISOString() } : { failedAt: delivery.failedAt, code: delivery.code }) };
				diagnostic.metadata.deliveries = states;
				diagnostic.save(true);
			}
		}
		const retained = reportArchives.get(delivery.deliveryId);
		if (retained) retained.facts = archiveFacts(envelope, delivery);
		updateReportArchive(delivery.deliveryId);
		emitChildState();
	};
	const settleBatch = (batchId: string, lifecycle = runs): void => {
		const batch = lifecycle?.batch(batchId);
		if (!batch) return;
		const batchKey = `${batch.ownerRunId}\0${batch.ownerSessionId}\0${batchId}`;
		if (sentBatches.has(batchKey)) return;
		sentBatches.add(batchKey);
		sendReport(batch);
		batches.delete(batchId);
		batchModes.delete(batchId);
		for (const result of batch.results) {
			reportAdmissions.delete(result.identity.runId);
			reportSettledAt.delete(result.identity.runId);
		}
		for (const [deliveryId, entry] of deliveries) if (entry.delivery.batchId === batchId) reportDisplays.delete(deliveryId);
		lifecycle?.compactBatch(batchId);
	};
	const publicationErrors = new Set<PublicationError>(["auth", "permission", "rate_limit", "size", "unavailable", "target_unavailable", "target_changed", "incomplete_listing", "remote_conflict", "unsafe_document", "binding_changed", "artifact_invalid"]);
	const safePublicationReason = (value: unknown): PublicationError => value instanceof PublicationFailure ? value.code : typeof value === "string" && publicationErrors.has(value as PublicationError) ? value as PublicationError : "unavailable";
	const persistScoutBlock = (result: ResultEnvelope, reason: unknown): void => {
		if (!result.identity.ticket) return;
		let safe = safePublicationReason(reason);
		try {
			const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
			try { recordPublicationBlock(db, result.identity.ticket, result.identity.runId, safe); }
			finally { db.close(); }
		} catch { safe = "artifact_invalid"; }
		const reference = result.artifact;
		result.artifact = { state: "blocked", reason: safe, ...(reference && "path" in reference && reference.path ? { path: reference.path } : {}), ...(reference && "hash" in reference && reference.hash ? { hash: reference.hash } : {}), ...(reference && "bytes" in reference && reference.bytes !== undefined ? { bytes: reference.bytes } : {}) };
	};
	const requestScoutControl = (result: ResultEnvelope, operation: "publish-plan-scout" | "reject-plan-scout", payload: { acceptanceId?: number }) => requestPlanControl(
		ENGINE_ROOT,
		operation,
		{ ticket: result.identity.ticket!, ...(process.env.YOKEMATE_PLAN_RUN_ID !== undefined ? { runId: process.env.YOKEMATE_PLAN_RUN_ID } : {}), child: result.identity, scoutSequence: scoutSequenceByRunId.get(result.identity.runId), ...payload },
		currentControlOrigin(ENGINE_ROOT, result.identity.ownerSessionId),
		resolveCoordinatorParent(ENGINE_ROOT),
	);
	const rejectScout = async (result: ResultEnvelope, reason: unknown, acceptanceId?: number): Promise<void> => {
		let safe = safePublicationReason(reason);
		try {
			const reply = await requestScoutControl(result, "reject-plan-scout", { acceptanceId });
			if (reply.state !== "accepted") safe = "unavailable";
		} catch { safe = "unavailable"; }
		persistScoutBlock(result, safe);
	};
	const assertPlanWriterAdmission = (identity: ChildIdentity): void => {
		if (identity.agent !== "plan-writer" || !identity.ticket || !runs) return;
		const state = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		try {
			const accepted = identity.acceptedInputId ? publicationAcceptanceById(state, identity.acceptedInputId) : undefined;
			if (accepted?.source_kind === "engineer-accepted-input") {
				if (accepted.ticket !== identity.ticket || accepted.owner_session_id !== identity.ownerSessionId || !accepted.continuation_id || !accepted.incident_id) throw new Error("plan-writer recovery source is foreign");
				assertPublishable(readPublicationArtifact(ENGINE_ROOT, accepted));
				return;
			}
		} finally { state.close(); }
		const scout = runs.assertPlanWriterAdmission(identity);
		const reference = scout.artifact;
		if (!reference || reference.state !== "accepted") throw new Error(`plan-writer requires the current accepted scout for ${identity.ticket}`);
		const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
		try {
			const acceptance = publicationAcceptanceById(db, reference.acceptanceId);
			if (!acceptance || acceptance.ticket !== identity.ticket || acceptance.owner_run_id !== scout.identity.ownerRunId || acceptance.owner_session_id !== scout.identity.ownerSessionId || acceptance.batch_id !== scout.identity.batchId || acceptance.run_id !== scout.identity.runId || acceptance.task_hash !== scout.identity.taskHash || acceptance.content_hash !== reference.hash || acceptance.artifact_path !== reference.path || acceptance.bytes !== reference.bytes) throw new Error(`plan-writer scout binding is invalid for ${identity.ticket}`);
			const bytes = readPublicationArtifact(ENGINE_ROOT, acceptance);
			if (bytes.length !== reference.bytes || sha256(bytes) !== reference.hash) throw new Error(`plan-writer scout artifact changed for ${identity.ticket}`);
		} finally { db.close(); }
	};
	const assertChildAdmission = (identity: ChildIdentity): void => {
		assertPlanWriterAdmission(identity);
		if (identity.agent !== "task-reviewer" || !identity.review || !runs) return;
		const scope = { ownerRunId: identity.ownerRunId, ownerSessionId: identity.ownerSessionId, cwd: identity.cwd, baseSha: identity.review.baseSha, headSha: identity.review.headSha };
		for (const prior of runs.terminalReviewers(identity)) {
			if (matchingObservedReview(runs, prior, scope, deliveries.values())) continue;
			const states = [...deliveries.values()].filter(({ delivery }) => delivery.runIds.includes(prior.runId)).map(({ delivery }) => `${delivery.deliveryId}:${delivery.state}`);
			throw new Error(`reviewer ${prior.runId} for this cwd/base/head is terminal without matching observed delivery${states.length ? ` (${states.join(", ")})` : ""}`);
		}
	};
	const settleResult = async (result: ResultEnvelope, report: boolean, lifecycle = ownedGenerationFor(result)?.runs ?? runs) => {
		if (!lifecycle || lifecycle.children.get(result.identity.runId)?.result || !lifecycle.owns(result.identity.runId, result.identity.ownerRunId, result.identity.ownerSessionId) || settlingRuns.has(result.identity.runId)) return;
		const completeProducer = beginProducer(ownedGenerationFor(result));
		settlingRuns.add(result.identity.runId);
		try {
		if (result.identity.agent === "plan-writer" && result.identity.ticket && result.identity.acceptedInputId && ["valid", "missing_final"].includes(result.payloadOutcome)) {
			const scope = planWriterScopes.get(result.identity.runId);
			let draft: ReturnType<typeof readPlanWriterSnapshot> | undefined;
			let source: "final" | "reconciled" = "final";
			try {
				if (!scope) throw new PlanWriterArtifactError(result.identity.ticket, "scope_not_found");
				if (result.payloadOutcome === "valid") {
					const target = /^(?:\[k7x2\] )?(\/[^\x00-\x1f\x7f]+)$/.exec(result.payload.trim());
					if (!target) throw new PlanWriterArtifactError(result.identity.ticket, "invalid_plan_path");
					draft = readPlanWriterSnapshot(ENGINE_ROOT, scope, target[1]!);
				} else {
					source = "reconciled";
					draft = reconcilePlanWriterArtifact(ENGINE_ROOT, scope);
					result.payload = draft.path;
					result.payloadOutcome = "valid";
				}
				result.planResult = { state: "verified", source, binding: toPlanBinding(draft), artifactBytes: draft.bytes.length };
			} catch (error) {
				const artifact = error instanceof PlanWriterArtifactError ? error : new PlanWriterArtifactError(result.identity.ticket, "artifact_unavailable");
				result.payloadOutcome = result.payloadOutcome === "missing_final" && artifact.code === "artifact_not_found" ? "missing_final" : "invalid_plan_result";
				result.payload = "";
				result.reviewVerdict = null;
				result.planResult = { state: "rejected", reason: artifact.code, ...(artifact.candidateCount === undefined ? {} : { candidateCount: artifact.candidateCount }) };
			}
			if (draft && result.planResult?.state === "verified") {
				result = boundBatchResult(result, lifecycle.batches.get(result.identity.batchId)!);
				if (result.payloadOutcome === "valid" && result.planResult?.state === "verified") {
					const state = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
					try {
						const dispatch = state.prepare("SELECT planning_identity,task_hash,actual_task_hash FROM workflow_writer_dispatch WHERE writer_run_id=? AND accepted_input_id=?").get(result.identity.runId, String(result.identity.acceptedInputId)) as { planning_identity?: string; task_hash?: string; actual_task_hash?: string } | undefined;
						if (!dispatch?.planning_identity || dispatch.task_hash !== result.identity.taskHash || dispatch.actual_task_hash !== result.actualTaskHash) {
							result.payloadOutcome = "invalid_plan_result";
							result.payload = "";
							result.planResult = { state: "rejected", reason: "writer_dispatch_mismatch" };
						} else {
							try {
								recordWriterDraft(state, { content_hash: draft.contentHash, accepted_input_id: result.identity.acceptedInputId!, planning_identity: dispatch.planning_identity, writer_run_id: result.identity.runId, writer_task_hash: result.identity.taskHash, writer_actual_task_hash: result.actualTaskHash, plan_path: draft.path, bytes: draft.bytes.length, result_hash: sha256(result.payload) });
								verifiedWriterDrafts.set(draft.contentHash, { acceptedInputId: result.identity.acceptedInputId!, planningIdentity: dispatch.planning_identity, runId: result.identity.runId });
							} catch (error) {
								result.payloadOutcome = "invalid_plan_result";
								result.payload = "";
								result.planResult = { state: "rejected", reason: error instanceof WriterDraftConflictError ? "writer_draft_conflict" : "artifact_unavailable" };
								if (!(error instanceof WriterDraftConflictError)) {
									const diagnostic = diagnostics.get(result.identity.runId);
									if (diagnostic) diagnostic.metadata.writerDraft = { refusal: "artifact_unavailable", error: errorMetadata(error) };
								}
							}
						}
					} finally { state.close(); }
				}
			}
			const diagnostic = diagnostics.get(result.identity.runId);
			if (diagnostic) diagnostic.metadata.writerResult = result.planResult;
		} else if (result.identity.agent === "plan-writer") {
			result.payload = "";
			result.reviewVerdict = null;
		}
		if (result.identity.agent === "plan-scout" && result.identity.ticket) {
			if (!lifecycle.isCurrentScout(result.identity) || stoppedPlanRuns.has(process.env.YOKEMATE_PLAN_RUN_ID ?? "") || result.processOutcome === "cancelled") {
				persistScoutBlock(result, "artifact_invalid");
			} else if (result.actualTaskHash !== result.identity.taskHash || result.payloadOutcome !== "valid" || result.artifact?.state !== "verified") {
				await rejectScout(result, result.artifact?.state === "blocked" ? result.artifact.reason : "artifact_invalid");
				const candidateId = scoutCandidateIds.get(result.identity.runId);
				if (candidateId) try { latestCtx?.ui.notify(`plan scout transport failed; audited recovery candidate ${candidateId}`, "warning"); } catch {}
			} else {
				let acceptanceId: number | undefined;
				try {
					const reference = result.artifact;
					const bytes = readPublicationArtifact(ENGINE_ROOT, { artifact_path: reference.path, content_hash: reference.hash, bytes: reference.bytes });
					assertPublishable(bytes);
					const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
					try { acceptanceId = acceptScoutArtifact(db, ENGINE_ROOT, result.identity, bytes).id; }
					finally { db.close(); }
					const reply = await requestScoutControl(result, "publish-plan-scout", { acceptanceId });
					if (reply.state !== "accepted" || !reply.artifactAcceptance) throw new Error(reply.reason ?? "parent control refused");
					result.artifact = reply.artifactAcceptance === "accepted"
						? { ...reference, state: "accepted", acceptanceId }
						: { ...reference, state: "superseded", acceptanceId };
					result.publication = { state: reply.publication ?? "pending", target: reply.target ?? `unresolved/${result.identity.ticket}`, revision: reply.revision ?? reference.hash, ...(reply.publicationId ? { publicationId: reply.publicationId } : {}), ...(reply.publication === "pending" ? { error: safePublicationReason(reply.reason) } : {}), path: reference.path, hash: reference.hash, bytes: reference.bytes, acceptanceId };
					if (result.publication.state === "pending") try { latestCtx?.ui.notify(`warning: scout publication → ${result.publication.target}: ${result.publication.error}`, "warning"); } catch {}
				} catch (error) {
					await rejectScout(result, error, acceptanceId);
				}
			}
		}
		const settledAt = Date.now();
		const diagnostic = diagnostics.get(result.identity.runId);
		if (diagnostic) {
			diagnostic.metadata.settledAt = new Date(settledAt).toISOString();
			diagnostic.metadata.closeAt ??= new Date(settledAt).toISOString();
			diagnostic.metadata.terminal ??= { processOutcome: result.processOutcome, exitCode: result.exitCode, signal: result.signal, stopReason: result.stopReason };
			diagnostic.metadata.artifact = result.artifact;
			diagnostic.metadata.publication = result.publication;
			const originalPayload = diagnostic.metadata.payload as Record<string, unknown> | undefined;
			diagnostic.metadata.payload = { ...originalPayload, outcome: result.payloadOutcome, retainedBytes: Buffer.byteLength(result.payload), retainedHash: sha256(result.payload), truncated: result.diagnostics?.final.truncated ?? false, verdict: result.reviewVerdict, outputLimit: result.outputLimit };
			diagnostic.save(true);
			const snapshotStorage = diagnostic.metadata.snapshotStorage as { state: "available" | "unavailable"; code?: string } | undefined;
			if (snapshotStorage && result.diagnostics) result.diagnostics.snapshotStorage = { ...snapshotStorage };
		}
		result = boundBatchResult(result, lifecycle.batches.get(result.identity.batchId)!);
		if (!lifecycle.settle(result)) return;
		reportSettledAt.set(result.identity.runId, settledAt);
		if (report) registerDelivery(result);
		const batch = lifecycle.batch(result.identity.batchId);
		if (batch) {
			registerDelivery(batch);
			if (!report) registerDelivery({ ...batch, kind: "chain" });
		}
		if (report) sendReport(result);
		} finally {
			settlingRuns.delete(result.identity.runId);
			if (result.identity.agent === "plan-writer") planWriterScopes.delete(result.identity.runId);
			completeProducer();
		}
	};

	requestOrdinaryCancellation = async (runId, initiator, ownerRunId, ownerSessionId) => {
		if (!runs) return cancellationResult(runId, "unknown", "unknown", false);
		const lifecycle = runs;
		if (lifecycle.children.has(runId) && !lifecycle.owns(runId, ownerRunId, ownerSessionId)) return cancellationResult(runId, "ordinary", "not_owned", false, "ordinary run belongs to another owner");
		const request = lifecycle.requestCancel(runId, initiator);
		if (request.result.targetKind === "unknown") return request.result;
		if (request.first) {
			const diagnostic = diagnostics.get(runId);
			if (diagnostic) {
				diagnostic.metadata.cancellationInitiator = initiator;
				diagnostic.save(false);
			}
		}
		const identity = lifecycle.children.get(runId)?.identity;
		const claimed = identity ? lifecycle.claimed(identity) : undefined;
		if (identity && claimed && request.first) {
			lifecycle.completeCleanup(identity);
			void settleResult(claimed, batchModes.get(identity.batchId) !== "chain", lifecycle).then(() => settleBatch(identity.batchId, lifecycle));
		}
		if (request.shouldSignal) {
			const owned = ordinaryProcesses.get(runId);
			const attached = identity ? lifecycle.process(identity) : undefined;
			const verified = !!owned && !!attached && detached.has(owned.process) && owned.process.pid === owned.pid && attached.pid === owned.pid && attached.starttime === owned.starttime && processStarttime(owned.pid) === owned.starttime && !owned.closed && !lifecycle.claimed(owned.identity) && !owned.termSent;
			if (!verified) return lifecycle.markCancellationUnconfirmed(runId, "process identity could not be verified for cancellation");
			let sent = false;
			try { sent = owned.process.kill("SIGTERM"); } catch {}
			if (!sent) return lifecycle.markCancellationUnconfirmed(runId, "process identity could not be verified for cancellation");
			owned.termSent = true;
			owned.killTimer = setTimeout(() => {
				const current = ordinaryProcesses.get(runId);
				if (current !== owned || current.closed || current.killSent || lifecycle.claimed(current.identity)) return;
				if (processStarttime(current.pid) !== current.starttime || current.process.pid !== current.pid) {
					lifecycle.markCancellationUnconfirmed(runId, "process identity could not be verified for cancellation");
					return;
				}
				let killed = false;
				try { killed = current.process.kill("SIGKILL"); } catch {}
				if (killed) current.killSent = true;
				else lifecycle.markCancellationUnconfirmed(runId, "process identity could not be verified for cancellation");
			}, 5000);
			owned.killTimer.unref();
		}
		return request.waitForCleanup ? await request.completion : request.result;
	};

	pi.registerTool({
		name: "plan_finish",
		label: "Plan finish",
		description: "Finish the owned plan run as blocked or cancelled.",
		parameters: Type.Object({ outcome: StringEnum(["blocked", "cancelled"] as const), reason: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<any> {
			if (process.env.YOKEMATE_MODE !== "plan" || !process.env.YOKEMATE_TICKET || !process.env.YOKEMATE_PLAN_RUN_ID) return { content: [{ type: "text", text: "plan_finish is available only to an owned plan worker" }], isError: true };
			const planRunId = process.env.YOKEMATE_PLAN_RUN_ID;
			stoppedPlanRuns.add(planRunId);
			const sessionId = ctx.sessionManager.getSessionId();
			const cancellations = Promise.all((runs?.active() ?? []).map((child) => requestOrdinaryCancellation(child.identity.runId, "plan_finish", planRunId, sessionId)));
			try {
				const reply = await requestPlanControl(ENGINE_ROOT, "plan-finished", { ticket: process.env.YOKEMATE_TICKET, runId: planRunId, outcome: params.outcome, reason: params.reason }, currentControlOrigin(ENGINE_ROOT, sessionId), resolveCoordinatorParent(ENGINE_ROOT));
				if (reply.state !== "accepted") throw new Error(reply.reason ?? "plan finish refused");
				const physical = await cancellations;
				return { content: [{ type: "text", text: `${params.outcome} recorded; ${JSON.stringify(physical)}` }], details: { planRunId, cancellations: physical } };
			} catch (error) {
				const physical = await cancellations;
				return { content: [{ type: "text", text: `${(error as Error).message}; ${JSON.stringify(physical)}` }], details: { planRunId, cancellations: physical }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "coordinator_merge",
		label: "Coordinator merge",
		description: "Request one fresh parent-owned merge attempt for an exact prepared PR.",
		parameters: Type.Object({ pr: Type.String(), expectedHead: Type.String(), method: StringEnum(["merge", "squash", "rebase"] as const) }),
		async execute(_id, params): Promise<any> {
			const runId = process.env.YOKEMATE_RUN_ID;
			if (!runId || process.env.YOKEMATE_MODE !== "ship" || process.env.YOKEMATE_ROLE !== "coordinator" || ownedReadyRunId !== runId) return { content: [{ type: "text", text: "coordinator_merge is available only to its owned ship coordinator" }], isError: true };
			try {
				const target = resolveCoordinatorParent(ENGINE_ROOT);
				const request = params as CoordinatorMergeRequest;
				const reply = await requestCoordinatorMerge(ENGINE_ROOT, runId, request, currentControlOrigin(ENGINE_ROOT, process.env.YOKEMATE_PARENT_SESSION_ID), target);
				if (reply.state !== "accepted" || !reply.merge) throw new Error(reply.reason ?? "merge request was refused");
				const text = `${reply.merge.repo} ${reply.merge.head} ${reply.merge.state}${reply.merge.reason ? `: ${reply.merge.reason}` : ""}`;
				return { content: [{ type: "text", text }], details: { kind: "yokemate-coordinator-merge", runId, ...reply.merge }, isError: reply.merge.state !== "merged" };
			} catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
		},
	});

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
			if (pending.length && !(params.outcome === "blocked" && pending.every((delivery) => ["delivery_failed", "delivery_unknown"].includes(delivery.state) && params.reason?.includes(delivery.deliveryId)))) return { content: [{ type: "text", text: `coordinator still has pending report delivery: ${pending.map((delivery) => delivery.deliveryId).join(", ")}` }], isError: true };
			await new Promise<void>((resolve) => setImmediate(resolve));
			const run = coordinators.get(runId);
			if (!run) {
				if (params.outcome === "done" && process.env.YOKEMATE_MODE === "ship") {
					try {
						const reply = await requestShipFinalize(ENGINE_ROOT, runId, currentControlOrigin(ENGINE_ROOT, process.env.YOKEMATE_PARENT_SESSION_ID), resolveCoordinatorParent(ENGINE_ROOT));
						if (reply.state !== "accepted" || !reply.finalization) throw new Error(reply.reason ?? "ship finalization was refused");
					} catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
				}
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
			sendCoordinatorTerminal(run, params.outcome, params.summary, params.reason, verification, rpcByRun.get(runId)?.diagnosticSnapshot(), rpcByRun.get(runId)?.process.exitCode === null);
			untrackRunning(rpcByRun.get(runId)?.process);
			void rpcByRun.get(runId)?.stop();
			rpcByRun.delete(runId);
			return { content: [{ type: "text", text: `${params.outcome} verified` }], details: { kind: "yokemate-coordinator-outcome", runId, outcome: params.outcome, verification }, terminate: true };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context, or cancel one exact owned run UUID.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), cancel (cancelRun only).",
			`Agents come from the nearest ${CONFIG_DIR_NAME}/agents — the yokemate root in the main chat, work/<TICKET>/${CONFIG_DIR_NAME}/agents in the task tab.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
			latestCtx = ctx;
			const admittedGeneration = sessionGeneration;
			if (finishingCoordinatorRunId && process.env.YOKEMATE_ROLE === "coordinator") return { content: [{ type: "text", text: "coordinator is finishing" }], isError: true };
			if (!params.cancelRun && shuttingDown) return { content: [{ type: "text", text: "parent session is shutting down; only cancellation remains available" }], isError: true };
			if (!params.cancelRun && process.env.YOKEMATE_PLAN_RUN_ID && stoppedPlanRuns.has(process.env.YOKEMATE_PLAN_RUN_ID)) return { content: [{ type: "text", text: "plan run is stopped; only cancellation and conversation remain available" }], isError: true };
			const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
			const currentSessionId = ctx.sessionManager?.getSessionId?.();
			const sessionId = currentSessionId ?? `unavailable:${process.pid}`;
			if (params.cancelRun) {
				if (!currentSessionId) return { content: [{ type: "text", text: "cancellation requires the current session identity" }], isError: true };
				const mixed = [params.coordinator, params.agent, params.task, params.ticket, params.tasks, params.chain, params.review, params.cwd].some((value) => value !== undefined);
				if (mixed) return { content: [{ type: "text", text: "cancelRun cannot be combined with launch parameters" }], isError: true };
				if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(params.cancelRun)) return { content: [{ type: "text", text: "cancelRun must be an exact UUID" }], isError: true };
				const ownerRunId = process.env.YOKEMATE_RUN_ID ?? sessionId;
				const resultResponse = (result: CancellationResult, text = JSON.stringify(result)) => ({ content: [{ type: "text" as const, text }], details: result, ...(["unknown", "not_owned"].includes(result.status) ? { isError: true } : {}) });
				try {
					if (runs?.children.has(params.cancelRun)) return resultResponse(await requestOrdinaryCancellation(params.cancelRun, "tool_cancel", ownerRunId, sessionId));
					const coordinator = coordinators.get(params.cancelRun);
					if (coordinator) {
						if (coordinator.identity.parentSessionId !== sessionId) return resultResponse(cancellationResult(params.cancelRun, "coordinator", "not_owned", false, "coordinator run belongs to another owner"));
						if (["done", "blocked"].includes(coordinator.state)) return resultResponse(cancellationResult(params.cancelRun, "coordinator", "already_terminal", true), `${params.cancelRun} cancelled`);
						workflowExtraction?.cancel("parent_cancel");
						shipPermits.invalidate();
						const fenced = fenceTargetedWorkflow([coordinator.identity.ticket], [params.cancelRun], "parent cancel");
						await Promise.all(fenced.coordinatorRunIds.map((id) => cancelCoordinator(id, "parent_cancel_run", Boolean(listRuns.get(id)))));
						return resultResponse(cancellationResult(params.cancelRun, "coordinator", "cancelled", true), `${params.cancelRun} cancelled`);
					}
					const list = listRuns.get(params.cancelRun);
					if (list) {
						const owned = "run" in list ? list.run.identity.parentSessionId === sessionId : list.identity.parentSessionId === sessionId;
						if (!owned) return resultResponse(cancellationResult(params.cancelRun, "list", "not_owned", false, "list run belongs to another owner"));
						const entries = "run" in list ? [list.entry] : list.entries;
						const recording = entries.filter((entry) => upgradeRecordingFence(entry.keyRunId));
						if (!recording.length && entries.every((entry) => ["refused", "recorded", "done", "blocked", "cancelled"].includes(entry.state))) return resultResponse(cancellationResult(params.cancelRun, "list", "already_terminal", true));
						workflowExtraction?.cancel("parent_cancel");
						shipPermits.invalidate();
						const fenced = fenceTargetedWorkflow(entries.map((entry) => entry.key), entries.map((entry) => entry.keyRunId), "parent cancel");
						await Promise.all(fenced.coordinatorRunIds.map((id) => cancelCoordinator(id, "parent_cancel_run", true)));
						for (const entry of entries) {
							if (recording.some((candidate) => candidate.keyRunId === entry.keyRunId)) { listRuns.cancel(entry.keyRunId); continue; }
							const agentName = typeof entry.immediate?.facts?.agentName === "string" ? entry.immediate.facts.agentName : undefined;
							listRuns.cancel(entry.keyRunId);
							if (coordinators.get(entry.keyRunId)) await cancelCoordinator(entry.keyRunId, "parent_cancel_run", true);
							if (agentName) await herdrAsync(["agent", "stop", agentName]).catch(() => {});
						}
						const outcome = cancellationResult(params.cancelRun, "list", recording.length ? "cancellation_requested" : "cancelled", recording.length === 0);
						return resultResponse(outcome, recording.length ? JSON.stringify(outcome) : `${params.cancelRun} cancelled`);
					}
					if (process.env.YOKEMATE_MODE) {
						const parent = resolveCoordinatorParent(root);
						const reply = await requestCoordinatorCancel(root, params.cancelRun, currentControlOrigin(root, sessionId), parent);
						if (reply.state === "accepted" && reply.cancellation) return resultResponse(reply.cancellation, reply.cancellation.status === "cancelled" ? `${params.cancelRun} cancelled` : JSON.stringify(reply.cancellation));
						if (reply.state === "refused") return resultResponse(cancellationResult(params.cancelRun, "unknown", "unknown", false, reply.reason ?? "parent cancellation refused"));
					}
					return resultResponse(cancellationResult(params.cancelRun, "unknown", "unknown", false));
				} catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			}
			if (ownedBinding) {
				try { assertPlanBinding(ownedBinding, readRecordedPlanBinding(ENGINE_ROOT, ownedBinding.ticket)); }
				catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			}
			const agentScope: AgentScope = params.agentScope ?? "project";
			let settings;
			try {
				settings = readRuntimeSettings(ENGINE_ROOT);
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { mode: "single", agentScope, projectAgentsDir: null, results: [] }, isError: true };
			}
			if (params.coordinator) {
				const origin = { YOKEMATE_MODE: process.env.YOKEMATE_MODE, YOKEMATE_TICKET: process.env.YOKEMATE_TICKET, YOKEMATE_ROLE: process.env.YOKEMATE_ROLE as "coordinator" | "executor" | undefined, sessionId, cwd: ctx.cwd };
				try {
					if (process.env.YOKEMATE_MODE) {
						const parent = resolveCoordinatorParent(root);
						const reply = await requestCoordinator(root, params.coordinator as CoordinatorRequest, currentControlOrigin(ctx.cwd, sessionId), parent);
						if (reply.state !== "accepted" || !reply.runId) throw new Error(reply.reason ?? "coordinator launch was not accepted");
						return { content: reply.results?.map((result) => ({ type: "text" as const, text: result.state === "accepted" ? `accepted ${result.keyRunId}, key ${result.key}, reserved` : `refused ${result.key}: ${result.reason}` })) ?? [{ type: "text" as const, text: `accepted ${reply.runId}` }], details: { runId: reply.runId, listRunId: reply.listRunId, identity: reply.identity, results: reply.results } };
					}
					const result = await startCoordinator(params.coordinator as CoordinatorRequest, ctx, origin, settings, { toolCallId });
					if (result.details.listRunId) flushListDelivery(result.details.listRunId);
					return result;
				} catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			}
			const { policy } = settings;
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
			if (!runs) runs = new ChildRuns(ownerRunId, sessionId, process.env.YOKEMATE_MODE === "plan" ? process.env.YOKEMATE_TICKET : undefined);
			if (runs.ownerRunId !== ownerRunId || runs.ownerSessionId !== sessionId) throw new Error("subagent owner changed");
			const admitPlanWriter = async (identity: ChildIdentity, requestedTask: string, expandedTask: string, claim: boolean): Promise<string> => {
				if (identity.agent !== "plan-writer") return expandedTask;
				if (!identity.ticket || !identity.acceptedInputId) throw new Error("plan-writer requires its current accepted scout");
				assertPlanWriterAdmission(identity);
				if (!identity.writerRevisionOf && requestedTask.includes("{previous}")) throw new Error("initial plan-writer input cannot come from {previous}");
				assertMandatoryBoundary("workflow.external-auth", !!ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model), "plan-writer requires configured external authentication");
				const state = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
				try {
					const accepted = publicationAcceptanceById(state, identity.acceptedInputId);
					if (!accepted || accepted.ticket !== identity.ticket) throw new Error("plan-writer accepted input is missing or foreign");
					const exact = readPublicationArtifact(ENGINE_ROOT, accepted);
					assertPublishable(exact);
					let planningIdentity = identity.writerRevisionOf ? verifiedWriterDrafts.get(identity.writerRevisionOf)?.planningIdentity ?? identity.runId : identity.runId;
					let incident;
					let provenance = "normal-transport";
					let markerInstructions = "";
					if (accepted.source_kind === "engineer-accepted-input") {
						if (process.env.YOKEMATE_MODE !== "plan" || !process.env.YOKEMATE_PLAN_RUN_ID) throw new Error("plan-writer requires its owned live plan worker");
						if (!accepted.incident_id || !accepted.candidate_id || !accepted.failure_hash || !accepted.continuation_id || !accepted.continuation_generation) throw new Error("plan-writer recovery provenance is incomplete");
						const candidate = state.prepare("SELECT planning_identity FROM plan_scout_candidate WHERE id=?").get(accepted.candidate_id) as { planning_identity?: string } | undefined;
						if (!candidate?.planning_identity || candidate.planning_identity !== process.env.YOKEMATE_PLAN_RUN_ID) throw new Error("plan-writer recovery lineage is foreign");
						const reply = await requestPlanControl(ENGINE_ROOT, "admit-plan-writer", { ticket: identity.ticket, runId: candidate.planning_identity, candidateId: accepted.candidate_id, failureHash: accepted.failure_hash, generation: accepted.continuation_generation, writerRunId: identity.runId, acceptanceId: accepted.id }, currentControlOrigin(ENGINE_ROOT, sessionId), resolveCoordinatorParent(ENGINE_ROOT));
						if (reply.state !== "accepted" || reply.planningIdentity !== accepted.continuation_id) throw new Error(reply.reason ?? "plan-writer recovery admission refused");
						planningIdentity = accepted.continuation_id;
						incident = incidentById(state, accepted.incident_id);
						if (!incident) throw new Error("plan-writer incident is missing");
						const target = resolvePublicationTarget(state, identity.ticket);
						if (target.targetHash !== incident.target_hash) throw new Error("plan-writer recovery target changed");
						const recorded = state.prepare("SELECT plan FROM work WHERE ticket=?").get(identity.ticket) as { plan?: string | null } | undefined;
						const plan = recorded?.plan ? (() => { const binding = readRecordedPlanBinding(ENGINE_ROOT, identity.ticket!); return { state: "recorded", hash: binding.contentHash, scopeHash: binding.scopeHash, pathHash: sha256(binding.path) }; })() : (() => { const scopeHash = sha256(JSON.stringify([identity.ticket, target.targetHash, accepted.content_hash, "plan-absent"])); return { state: "absent", hash: sha256("absent"), scopeHash, pathHash: sha256("absent") }; })();
						if (incident.scope_hash !== plan.scopeHash || incident.plan_state !== plan.state || incident.plan_hash !== plan.hash || incident.plan_scope_hash !== plan.scopeHash || incident.plan_path_hash !== plan.pathHash) throw new Error("plan-writer recovery plan or scope changed");
						provenance = `engineer-accepted-input incident=${accepted.incident_id} candidate=${accepted.candidate_id} source-run=${accepted.source_run_id} failure=${accepted.failure_hash} skipped=${accepted.skipped_json} preserved=${accepted.preserved_json} plan-only=true`;
						markerInstructions = `\n\nThe plan's Assumptions section must preserve these exact audit lines:\nBREAK-GLASS: engineer-accepted-input\nincident: ${accepted.incident_id}\nsource-run: ${accepted.source_run_id}\nsource-hash: ${accepted.content_hash}\nreason: ${accepted.incident_reason}\nskipped: failed-transport-envelope`;
					} else if (accepted.source_kind !== "normal-transport" || accepted.owner_session_id !== sessionId) throw new Error("plan-writer normal source is not owned by this plan worker");
					if (identity.writerRevisionOf) {
						const draft = verifiedWriterDrafts.get(identity.writerRevisionOf);
						if (!draft || draft.acceptedInputId !== accepted.id || draft.planningIdentity !== planningIdentity) throw new Error("plan-writer revision draft is unknown or foreign");
					}
					const source = new TextDecoder("utf-8", { fatal: true }).decode(exact);
					const injected = `${expandedTask}${markerInstructions}\n\nAccepted scout input (${provenance}; hash=${accepted.content_hash}; bytes=${accepted.bytes}):\n\n${source}`;
					if (claim) claimWriterDispatch(state, incident, { acceptedInputId: String(accepted.id), planningIdentity, kind: identity.writerRevisionOf ? "revision" : "initial", revisionOf: identity.writerRevisionOf, writerRunId: identity.runId, taskHash: identity.taskHash, actualTaskHash: sha256(injected) });
					return injected;
				} finally { state.close(); }
			};
			const runDetachedAgent = async (mode: "single" | "parallel" | "chain", identity: ChildIdentity, task: string, lifecycle: ChildRuns, step?: number): Promise<{ envelope: ResultEnvelope; output: string }> => {
				let child: ChildProcess | undefined;
				let envelope: ResultEnvelope | undefined;
				let output = "";
				let cleanupError: string | undefined;
				let cleanupPath: string | undefined;
				try {
					lifecycle.resolveTask(identity, task);
					if (shuttingDown) {
						envelope = lifecycle.claimNoSpawn(identity);
						if (!envelope) throw new Error("subagent run cannot be fenced during shutdown");
						return { envelope, output };
					}
					if (!lifecycle.start(identity)) {
						envelope = lifecycle.claimed(identity) ?? lifecycle.claimNoSpawn(identity);
						if (!envelope) throw new Error("subagent run cannot start");
						return { envelope, output };
					}
					assertPlanWriterAdmission(identity);
					task = await admitPlanWriter(identity, diagnostics.get(identity.runId)?.metadata.requestedTask as string ?? task, task, true);
					lifecycle.resolveTask(identity, task);
					emitChildState();
					const result = await runSingleAgent(ctx.cwd, dispatchDefaults, agents, identity.agent, task, identity.cwd, step, undefined, undefined, makeDetails(mode), (proc) => {
						child = proc;
						detached.add(proc);
						trackRunning(proc, identity.agent, task);
					}, identity, lifecycle, diagnostics.get(identity.runId)!);
					output = getFinalOutput(result.messages);
					cleanupError = result.cleanupError;
					cleanupPath = result.cleanupPath;
					envelope = result.envelope ?? lifecycle.claimNoSpawn(identity) ?? resultEnvelope(identity, task, { processOutcome: "not_started", exitCode: null, signal: null }, "");
					const diagnostic = diagnostics.get(identity.runId)!;
					if (result.agentSource === "unknown") diagnostic.metadata.displayDiagnostic = "unknown_agent";
					const originalPayload = diagnostic.metadata.payload as Record<string, unknown> | undefined;
					const retainedBytes = Buffer.byteLength(envelope.payload);
					const retainedHash = sha256(envelope.payload);
					diagnostic.metadata.payload = { ...originalPayload, outcome: envelope.payloadOutcome, retainedBytes, retainedHash, truncated: originalPayload === undefined ? false : originalPayload.bytes !== retainedBytes || originalPayload.hash !== retainedHash, verdict: envelope.reviewVerdict, outputLimit: envelope.outputLimit };
					diagnostic.save(true);
				} catch (error) {
					if (error instanceof PromptCleanupFailure) {
						cleanupError = "temporary prompt cleanup could not be verified";
						cleanupPath = error.dir;
					}
					const diagnostic = diagnostics.get(identity.runId);
					if (diagnostic) {
						diagnostic.metadata.spawnError = errorMetadata(error);
						if (error instanceof PromptCleanupFailure) diagnostic.metadata.cleanupError = { reason: cleanupError, path: error.dir, writeFailure: error.writeFailure, cleanupFailure: error.cleanupFailure };
						diagnostic.save(true);
					}
					envelope = lifecycle.claimTerminal(identity, task, { processOutcome: "spawn_error", exitCode: null, signal: null }, "")?.result ?? lifecycle.claimed(identity);
					if (!envelope) throw error;
				} finally {
					if (child) detached.delete(child);
					untrackRunning(child);
					ordinaryProcesses.delete(identity.runId);
					if (cleanupError) lifecycle.markCancellationUnconfirmed(identity.runId, cleanupPath ? `${cleanupError}: ${cleanupPath}` : cleanupError);
					else lifecycle.completeCleanup(identity);
				}
				return { envelope: envelope!, output };
			};
			const launch = async (mode: "single" | "parallel" | "chain", tasks: { agent: string; task: string; cwd?: string; ticket?: string; review?: { baseSha: string; headSha: string }; acceptedInputId?: number; writerRevisionOf?: string }[]) => {
				tasks = await Promise.all(tasks.map(async (task) => {
					if (task.agent !== "plan-writer" || task.acceptedInputId) return task;
					const ticket = task.ticket ?? process.env.YOKEMATE_TICKET;
					const current = ticket ? runs!.currentScout(ticket) : undefined;
					if (current?.artifact?.state === "accepted") return { ...task, ticket, acceptedInputId: current.artifact.acceptanceId };
					const runId = process.env.YOKEMATE_PLAN_RUN_ID;
					if (!ticket || !runId || process.env.YOKEMATE_MODE !== "plan") return task;
					const input = await requestPlanControl(ENGINE_ROOT, "read-plan-writer-input", { ticket, runId }, currentControlOrigin(ENGINE_ROOT, sessionId), resolveCoordinatorParent(ENGINE_ROOT));
					if (input.state !== "accepted" || !input.acceptanceId) throw new Error(input.reason ?? "plan writer accepted input is unavailable");
					return { ...task, ticket, acceptedInputId: input.acceptanceId };
				}));
				const writerScopes = tasks.map((task) => task.agent === "plan-writer"
					? resolvePlanWriterScope(ENGINE_ROOT, task.ticket ?? process.env.YOKEMATE_TICKET ?? "")
					: undefined);
				if (shuttingDown || sessionGeneration !== admittedGeneration) throw new Error("parent session changed before subagent admission");
				const units = mode === "chain" ? 1 : tasks.length;
				const admission = subagentAdmission(settings, mode, units, activeUnits);
				if (admission) throw new Error(admission);
				const ack = runs!.admit(toolCallId, tasks, ctx.cwd, assertChildAdmission);
				for (const [index, child] of ack.children.entries()) {
					const scope = writerScopes[index];
					if (scope) planWriterScopes.set(child.identity.runId, scope);
				}
				for (const [index, child] of ack.children.entries()) await admitPlanWriter(child.identity, tasks[index]!.task, tasks[index]!.task, false);
				if (mode === "chain") for (const child of ack.children.slice(1)) runs!.defer(child.identity);
				const admittedAt = Date.now();
				for (const [index, { identity }] of ack.children.entries()) {
					if (identity.agent === "plan-scout") scoutSequenceByRunId.set(identity.runId, 2 * ++nextScoutSequence);
					reportAdmissions.set(identity.runId, { startedAt: admittedAt, taskExcerpt: reportTaskExcerpt(tasks[index]!.task), ordinal: index + 1 });
					const metadata: Record<string, unknown> = { identity, admissionAt: new Date(admittedAt).toISOString(), ownerPid: process.pid, ownerStarttime: processStarttime(process.pid), runtime: { node: process.version, pi: "0.85.1", contract: 1 }, extension: fileProvenance(new URL(import.meta.url).pathname), guard: fileProvenance(path.join(root, "src/guards.ts")), taskHash: identity.taskHash, requestedTask: tasks[index]!.task, cancellationInitiator: "unknown", deliveries: {} };
					const diagnostic = { metadata, save: (completed: boolean) => {
						const status = snapshots.write(identity.ownerRunId, identity.runId, metadata, completed);
						metadata.snapshotStorage = status;
					} };
					diagnostics.set(identity.runId, diagnostic);
					diagnostic.save(false);
				}
				const admissionFence = process.env.YOKEMATE_MODE === "plan"
					? Promise.all(ack.children.filter(({ identity }) => identity.agent === "plan-scout" && identity.ticket).map(async ({ identity }) => {
						const db = openDb(path.join(ENGINE_ROOT, "yokemate.db"));
						try { revokePendingPlanRecords(db, identity.ticket!); } finally { db.close(); }
						const reply = await requestPlanControl(ENGINE_ROOT, "reject-plan-scout", { ticket: identity.ticket!, runId: process.env.YOKEMATE_PLAN_RUN_ID, child: identity, scoutSequence: scoutSequenceByRunId.get(identity.runId)! - 1 }, currentControlOrigin(ENGINE_ROOT, identity.ownerSessionId), resolveCoordinatorParent(ENGINE_ROOT));
						if (reply.state !== "accepted") throw new Error(reply.reason ?? "current scout admission was not fenced");
					}))
					: Promise.resolve([]);
				activeUnits += units;
				batches.add(toolCallId);
				batchModes.set(toolCallId, mode);
				const dispatchRuns = runs!;
				const dispatchGeneration = currentOwnedGeneration();
				if (dispatchGeneration) dispatchGeneration.batchDispatches += 1;
				let resolveCompletion!: () => void;
				const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
				batchCompletions.set(toolCallId, { promise: completion, resolve: resolveCompletion });
				emitChildState();
				const execute = async () => {
					try {
						try { await admissionFence; }
						catch {
							for (const { identity } of ack.children) await settleResult(resultEnvelope(identity, tasks[ack.children.findIndex((child) => child.identity.runId === identity.runId)]!.task, { processOutcome: "not_started", exitCode: null, signal: null }, ""), mode !== "chain", dispatchRuns);
							if (mode === "chain") sendReport(dispatchRuns.batch(toolCallId, "chain")!);
							settleBatch(toolCallId, dispatchRuns);
							return;
						}
						if (mode === "chain") {
							let previous = "";
							let failed = false;
							for (let i = 0; i < tasks.length; i++) {
								const identity = ack.children[i]!.identity;
								const task = tasks[i]!.task.replace(/\{previous\}/g, previous);
								let terminal: { envelope: ResultEnvelope; output: string };
								if (failed) {
									dispatchRuns.resolveTask(identity, task);
									const envelope = dispatchRuns.claimNoSpawn(identity)!;
									dispatchRuns.completeCleanup(identity);
									terminal = { envelope, output: "" };
								} else terminal = await runDetachedAgent(mode, identity, task, dispatchRuns, i + 1);
								const { envelope: result, output } = terminal;
								await settleResult(result, false, dispatchRuns);
								const finalized = await dispatchRuns.finalized(identity) ?? result;
								failed ||= failedEnvelope(finalized);
								previous = identity.agent === "plan-writer" && finalized.planResult?.state === "verified" ? finalized.planResult.binding.path : output;
							}
							sendReport(dispatchRuns.batch(toolCallId, "chain")!);
						} else {
							await mapWithConcurrencyLimit(tasks, subagentConcurrency(settings, tasks.length), async (task, i) => {
								const { envelope: result } = await runDetachedAgent(mode, ack.children[i]!.identity, task.task, dispatchRuns);
								await settleResult(result, true, dispatchRuns);
							});
						}
						settleBatch(toolCallId, dispatchRuns);
					} finally {
						activeUnits -= units;
						if (dispatchGeneration) {
							dispatchGeneration.batchDispatches = Math.max(0, dispatchGeneration.batchDispatches - 1);
							wakeOwnedGeneration(dispatchGeneration);
							emitChildState();
						}
						batchCompletions.get(toolCallId)?.resolve();
						batchCompletions.delete(toolCallId);
					}
				};
				void execute().catch(() => console.error("[subagent] detached dispatch failed"));
				return { content: [{ type: "text", text: `Detached, not terminal: ${JSON.stringify(ack)}` }], details: { ...makeDetails(mode)([]), ...ack, display: { version: 1, members: ack.children.map(({ identity }) => ({ taskExcerpt: reportAdmissions.get(identity.runId)?.taskExcerpt ?? "" })) } } };
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
			if (params.agent && params.task) return launch("single", [{ agent: params.agent, task: params.task, cwd: params.cwd, ticket: params.ticket, review: params.review, acceptedInputId: params.acceptedInputId, writerRevisionOf: params.writerRevisionOf }]);

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.cancelRun) return new Text(theme.fg("toolTitle", theme.bold("subagent cancel ")) + theme.fg("accent", args.cancelRun), 0, 0);
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
			if (!details?.results?.length) {
				const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				return new Text(text || "(no output)", 0, 0);
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
