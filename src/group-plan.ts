import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { activateGroupRevision } from "./group-state.ts";
import { canonicalHash } from "./group-state.ts";
import type { PlanApproachOwner, PlanApproachStore, AcceptedScoutBinding } from "./plan-approach.ts";
import type { PlanBinding } from "./plan-binding.ts";
import type { TaskTree } from "./group-tree.ts";

export interface GroupExecutionMember {
  ticket: string;
  parent: string | null;
  ownWork: "implementation" | "coordination-only";
  implementationRepos: string[];
  requirements: string[];
}
export interface GroupRequirement { id: string; sourceTicket: string; text: string; owner: string; planStep: string; acceptance: string }
export interface GroupContract { id: string; providers: string[]; consumers: string[]; specification: string; verification: string }
export interface GroupStartDependency { before: string; after: string; when: "integrated" | "contract-approved"; contractId?: string }
export interface GroupAcceptanceObligation { id: string; members: string[]; repos: string[]; criterion: string; evidenceRequired: string }
export interface GroupExecutionManifest {
  version: 1;
  root: string;
  ownerProject: string;
  members: GroupExecutionMember[];
  requirements: GroupRequirement[];
  contracts: GroupContract[];
  startDependencies: GroupStartDependency[];
  acceptanceObligations: GroupAcceptanceObligation[];
  repositories: { repo: string; role: string }[];
  planRefs: { ticket: string; path: string }[];
}
export interface CompatibilityReport {
  inputHash: string;
  requirements: { id: string; coveredBy: string; evidence: string }[];
  contracts: { id: string; providers: string[]; consumers: string[]; evidence: string }[];
  parentWork: { ticket: string; evidence: string }[];
  conflicts: unknown[];
}
export interface BoundGroupRevision {
  revisionHash: string;
  manifestHash: string;
  manifest: GroupExecutionManifest;
  bindings: PlanBinding[];
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`group manifest ${label} must be nonempty strings`);
  return value as string[];
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`group manifest ${label} is required`);
  return value;
};
const ticket = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(result)) throw new Error(`group manifest ${label} is not a ticket`);
  return result;
};
const unique = (values: string[], label: string): void => { if (new Set(values).size !== values.length) throw new Error(`group manifest has duplicate ${label}`); };

export function parseGroupExecution(markdown: string): GroupExecutionManifest {
  const steps = /^## Steps\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(markdown)?.[1];
  if (!steps) throw new Error("group execution block must be inside Steps");
  const blocks = [...steps.matchAll(/```group-execution\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) throw new Error("root plan must contain exactly one group-execution block");
  let raw: unknown;
  try { raw = parse(blocks[0]![1]!); } catch { throw new Error("group execution block is invalid YAML"); }
  if (!object(raw)) throw new Error("group execution block must be an object");
  const members = Array.isArray(raw.members) ? raw.members.map((value, index): GroupExecutionMember => {
    if (!object(value)) throw new Error(`group manifest member ${index} is invalid`);
    const ownWork = value.ownWork;
    if (ownWork !== "implementation" && ownWork !== "coordination-only") throw new Error(`group manifest member ${index} ownWork is invalid`);
    return { ticket: ticket(value.ticket, `members[${index}].ticket`), parent: value.parent === null ? null : ticket(value.parent, `members[${index}].parent`), ownWork, implementationRepos: strings(value.implementationRepos, `members[${index}].implementationRepos`), requirements: strings(value.requirements, `members[${index}].requirements`) };
  }) : [];
  const requirements = Array.isArray(raw.requirements) ? raw.requirements.map((value, index): GroupRequirement => {
    if (!object(value)) throw new Error(`group manifest requirement ${index} is invalid`);
    return { id: text(value.id, `requirements[${index}].id`), sourceTicket: ticket(value.sourceTicket, `requirements[${index}].sourceTicket`), text: text(value.text, `requirements[${index}].text`), owner: ticket(value.owner, `requirements[${index}].owner`), planStep: text(value.planStep, `requirements[${index}].planStep`), acceptance: text(value.acceptance, `requirements[${index}].acceptance`) };
  }) : [];
  const contracts = Array.isArray(raw.contracts) ? raw.contracts.map((value, index): GroupContract => {
    if (!object(value)) throw new Error(`group manifest contract ${index} is invalid`);
    return { id: text(value.id, `contracts[${index}].id`), providers: strings(value.providers, `contracts[${index}].providers`), consumers: strings(value.consumers, `contracts[${index}].consumers`), specification: text(value.specification, `contracts[${index}].specification`), verification: text(value.verification, `contracts[${index}].verification`) };
  }) : [];
  const startDependencies = Array.isArray(raw.startDependencies) ? raw.startDependencies.map((value, index): GroupStartDependency => {
    if (!object(value) || value.when !== "integrated" && value.when !== "contract-approved") throw new Error(`group manifest start dependency ${index} is invalid`);
    return { before: ticket(value.before, `startDependencies[${index}].before`), after: ticket(value.after, `startDependencies[${index}].after`), when: value.when, ...(value.contractId === undefined ? {} : { contractId: text(value.contractId, `startDependencies[${index}].contractId`) }) };
  }) : [];
  const acceptanceObligations = Array.isArray(raw.acceptanceObligations) ? raw.acceptanceObligations.map((value, index): GroupAcceptanceObligation => {
    if (!object(value)) throw new Error(`group manifest acceptance obligation ${index} is invalid`);
    return { id: text(value.id, `acceptanceObligations[${index}].id`), members: strings(value.members, `acceptanceObligations[${index}].members`), repos: strings(value.repos, `acceptanceObligations[${index}].repos`), criterion: text(value.criterion, `acceptanceObligations[${index}].criterion`), evidenceRequired: text(value.evidenceRequired, `acceptanceObligations[${index}].evidenceRequired`) };
  }) : [];
  const repositories = Array.isArray(raw.repositories) ? raw.repositories.map((value, index) => {
    if (!object(value)) throw new Error(`group manifest repository ${index} is invalid`);
    return { repo: text(value.repo, `repositories[${index}].repo`), role: text(value.role, `repositories[${index}].role`) };
  }) : [];
  const planRefs = Array.isArray(raw.planRefs) ? raw.planRefs.map((value, index) => {
    if (!object(value)) throw new Error(`group manifest plan ref ${index} is invalid`);
    return { ticket: ticket(value.ticket, `planRefs[${index}].ticket`), path: text(value.path, `planRefs[${index}].path`) };
  }) : [];
  if (raw.version !== 1) throw new Error("group manifest version must be 1");
  return { version: 1, root: ticket(raw.root, "root"), ownerProject: text(raw.ownerProject, "ownerProject"), members, requirements, contracts, startDependencies, acceptanceObligations, repositories, planRefs };
}

export function validateGroupManifest(manifest: GroupExecutionManifest, tree?: TaskTree): void {
  if (!manifest.members.length || !manifest.requirements.length || !manifest.repositories.length) throw new Error("group manifest members, requirements and repositories are required");
  const members = manifest.members.map((member) => member.ticket);
  unique(members, "member");
  if (!members.includes(manifest.root)) throw new Error("group manifest root is not a member");
  for (const member of manifest.members) {
    if (member.ticket === manifest.root && member.parent !== null) throw new Error("group manifest root parent must be null");
    if (member.ticket !== manifest.root && (!member.parent || !members.includes(member.parent))) throw new Error(`${member.ticket}: group manifest parent is missing`);
    if (member.ownWork === "implementation" && member.implementationRepos.length === 0) throw new Error(`${member.ticket}: implementation own-work requires a repository`);
    if (member.ownWork === "coordination-only" && member.implementationRepos.length !== 0) throw new Error(`${member.ticket}: coordination-only cannot declare implementation repositories`);
  }
  if (tree) {
    const treeRows = tree.nodes.map((node) => [node.ticket, node.parentIdentity ? tree.nodes.find((parent) => parent.identity === node.parentIdentity)?.ticket ?? null : null]);
    const manifestRows = manifest.members.map((member) => [member.ticket, member.parent]);
    if (JSON.stringify(treeRows) !== JSON.stringify(manifestRows)) throw new Error("group manifest membership does not match the discovered tree");
  }
  const requirementIds = manifest.requirements.map((requirement) => requirement.id);
  unique(requirementIds, "requirement id");
  const declaredRequirements = new Set(manifest.members.flatMap((member) => member.requirements));
  if (requirementIds.some((id) => !declaredRequirements.has(id)) || [...declaredRequirements].some((id) => !requirementIds.includes(id))) throw new Error("group manifest requirement ownership is incomplete");
  for (const requirement of manifest.requirements) if (!members.includes(requirement.sourceTicket) || !members.includes(requirement.owner)) throw new Error(`${requirement.id}: requirement references an unknown member`);
  const repositories = manifest.repositories.map((repository) => repository.repo);
  unique(repositories, "repository");
  if (repositories.some((repo) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new Error("group manifest repository is not canonical");
  const implementationRepos = [...new Set(manifest.members.flatMap((member) => member.implementationRepos))].sort();
  if (JSON.stringify([...repositories].sort()) !== JSON.stringify(implementationRepos)) throw new Error("group manifest repository union does not match member implementation repositories");
  const contractIds = manifest.contracts.map((contract) => contract.id);
  unique(contractIds, "contract id");
  for (const contract of manifest.contracts) if (!contract.providers.length || !contract.consumers.length || [...contract.providers, ...contract.consumers].some((member) => !members.includes(member))) throw new Error(`${contract.id}: contract references an unknown provider or consumer`);
  const edges = new Map(members.map((member) => [member, [] as string[]]));
  for (const dependency of manifest.startDependencies) {
    if (!members.includes(dependency.before) || !members.includes(dependency.after)) throw new Error("group start dependency references an unknown member");
    if (dependency.when === "contract-approved" && (!dependency.contractId || !contractIds.includes(dependency.contractId))) throw new Error("contract-approved dependency requires a known contract");
    edges.get(dependency.before)!.push(dependency.after);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (member: string): void => {
    if (visiting.has(member)) throw new Error("group start dependencies contain a cycle");
    if (visited.has(member)) return;
    visiting.add(member);
    for (const next of edges.get(member) ?? []) visit(next);
    visiting.delete(member);
    visited.add(member);
  };
  for (const member of members) visit(member);
  const obligationIds = manifest.acceptanceObligations.map((obligation) => obligation.id);
  unique(obligationIds, "acceptance obligation id");
  for (const obligation of manifest.acceptanceObligations) if (obligation.members.some((member) => !members.includes(member)) || obligation.repos.some((repo) => !repositories.includes(repo))) throw new Error(`${obligation.id}: acceptance obligation references unknown scope`);
  const refs = manifest.planRefs.map((ref) => ref.ticket);
  unique(refs, "plan ref");
  if (JSON.stringify([...refs].sort()) !== JSON.stringify([...members].sort())) throw new Error("group manifest plan refs must cover every member exactly once");
  for (const ref of manifest.planRefs) if (isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes("..") || !ref.path.startsWith("ai/")) throw new Error(`${ref.ticket}: group plan ref must be knowledge-relative`);
}

export function bindGroupRevision(input: { rootIdentity: string; ownerProject: string; tree: TaskTree; manifest: GroupExecutionManifest; bindings: PlanBinding[] }): BoundGroupRevision {
  validateGroupManifest(input.manifest, input.tree);
  if (input.manifest.ownerProject !== input.ownerProject) throw new Error("group manifest owner project mismatch");
  const bindings = input.bindings.map((binding) => ({ ...binding, repositories: [...binding.repositories].sort() })).sort((a, b) => a.ticket.localeCompare(b.ticket));
  const tickets = bindings.map((binding) => binding.ticket);
  if (new Set(tickets).size !== tickets.length || JSON.stringify(tickets) !== JSON.stringify(input.manifest.members.map((member) => member.ticket).sort())) throw new Error("group plan bindings must cover every member exactly once");
  const manifestHash = canonicalHash(input.manifest);
  const revisionHash = canonicalHash({ version: 1, rootIdentity: input.rootIdentity, ownerProject: input.ownerProject, tree: input.tree, members: input.manifest.members, requirements: input.manifest.requirements, contracts: input.manifest.contracts, startDependencies: input.manifest.startDependencies, acceptanceObligations: input.manifest.acceptanceObligations, repositories: input.manifest.repositories, planBindings: bindings });
  return { revisionHash, manifestHash, manifest: input.manifest, bindings };
}

export function validateCompatibility(report: CompatibilityReport, revision: BoundGroupRevision): void {
  if (report.inputHash !== revision.revisionHash) throw new Error("compatibility report input hash is stale");
  if (report.conflicts.length) throw new Error("compatibility report contains conflicts");
  const coveredRequirements = new Set(report.requirements.filter((item) => item.coveredBy && item.evidence).map((item) => item.id));
  for (const requirement of revision.manifest.requirements) if (!coveredRequirements.has(requirement.id)) throw new Error(`${requirement.id}: requirement is not covered by compatibility evidence`);
  const coveredContracts = new Set(report.contracts.filter((item) => item.providers.length && item.consumers.length && item.evidence).map((item) => item.id));
  for (const contract of revision.manifest.contracts) if (!coveredContracts.has(contract.id)) throw new Error(`${contract.id}: contract is not covered by compatibility evidence`);
  const parentWork = new Set(report.parentWork.filter((item) => item.evidence).map((item) => item.ticket));
  for (const member of revision.manifest.members) if ((member.parent !== null || member.ticket === revision.manifest.root) && !parentWork.has(member.ticket)) throw new Error(`${member.ticket}: parent/root own-work declaration is not covered`);
}

export function activateGroupPlan(db: DatabaseSync, input: { groupId: string; rootIdentity: string; tree: TaskTree; revision: BoundGroupRevision; compatibility: CompatibilityReport; approachStore: PlanApproachStore; approachOwner: PlanApproachOwner; acceptedScouts: AcceptedScoutBinding[]; planRecordIds: Map<string, number> }): void {
  validateCompatibility(input.compatibility, input.revision);
  const receipt = input.approachStore.assertCurrent({ treeHash: input.tree.treeHash, acceptedScouts: input.acceptedScouts }, input.approachOwner);
  activateGroupRevision(db, {
    groupId: input.groupId,
    revisionHash: input.revision.revisionHash,
    treeHash: input.tree.treeHash,
    manifest: input.revision.manifest,
    bindings: input.revision.bindings,
    compatibility: input.compatibility,
    approachReceiptId: receipt.id,
    members: input.tree.nodes.map((node) => ({ identity: node.identity, ticket: node.ticket, parentIdentity: node.parentIdentity, planRecordId: input.planRecordIds.get(node.ticket), trackerState: node.trackerState })),
  });
  input.approachStore.assertCurrent({ treeHash: input.tree.treeHash, acceptedScouts: input.acceptedScouts, consume: true }, input.approachOwner);
}
