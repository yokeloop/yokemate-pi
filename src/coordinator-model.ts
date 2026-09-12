import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveCliModel, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ExpectedCoordinatorModel {
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
}

type CoordinatorRegistry = Pick<ExtensionContext["modelRegistry"], "getAll" | "hasConfiguredAuth">;
type ResolverRuntime = Pick<Parameters<typeof resolveCliModel>[0]["modelRuntime"], "getModels" | "hasConfiguredAuth">;

export function resolveCoordinatorModel(
  specification: string,
  registry: CoordinatorRegistry,
): { expected: ExpectedCoordinatorModel; warning?: string } {
  const models = registry.getAll();
  const runtime: ResolverRuntime = {
    getModels: () => models,
    hasConfiguredAuth: (provider) => {
      const representative = models.find((model) => model.provider === provider);
      return representative ? registry.hasConfiguredAuth(representative) : false;
    },
  };
  const resolved = resolveCliModel({
    cliModel: specification,
    modelRuntime: runtime as Parameters<typeof resolveCliModel>[0]["modelRuntime"],
  });
  if (resolved.error || !resolved.model)
    throw new Error(`coordinator model resolution failed: ${specification}: ${resolved.error ?? "no model resolved"}`);
  return {
    expected: {
      provider: resolved.model.provider,
      id: resolved.model.id,
      ...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    },
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
  };
}
