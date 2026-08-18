// agentic-composition
import {
  FileSystemStateStore,
  SystemEnvironmentProbe,
  createBootstrapCapability,
} from "./adapters.mjs";
import { OrchestrationKernel } from "./orchestration-kernel.mjs";

export function createOrchestrationComposition({
  cacheDirectory,
  capabilities,
  capabilityTtlMs,
  configuration,
  root,
  telemetrySinks,
  temporaryDirectory,
} = {}) {
  const bootstrapCapability = createBootstrapCapability();
  const stateStore = new FileSystemStateStore({ root });
  const environmentProbe = new SystemEnvironmentProbe({
    cacheDirectory,
    capabilities,
    temporaryDirectory,
  });
  const kernel = new OrchestrationKernel({
    bootstrapCapability,
    capabilityTtlMs,
    configuration,
    environmentProbe,
    stateStore,
    telemetrySinks,
  });

  return Object.freeze({
    apply: kernel.apply.bind(kernel),
    bootstrapCapability,
    inspect: kernel.inspect.bind(kernel),
  });
}
