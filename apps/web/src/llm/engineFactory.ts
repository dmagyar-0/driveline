/**
 * Engine-injection seam for the Format Agent dialog (docs/12 §11 — deterministic
 * e2e).
 *
 * The UI never constructs `ClientOrchestratedEngine` directly: it asks this
 * module for a factory, which by default builds the real client-orchestrated
 * engine. Tests (and the smoke harness, if it wanted to) swap in a fake engine
 * via `setFormatAgentEngineFactory`, so the WHOLE dialog flow — consent →
 * progress → success — can be driven with NO network and NO key.
 *
 * Why a module-scoped override and not a React context / store field:
 *  - It lives INSIDE the lazy `llm/` chunk, so the seam itself adds nothing to
 *    the first-load bundle (the override is set only after the chunk is loaded).
 *  - It keeps the dialog free of test-only props; the production path is the
 *    default factory with zero ceremony.
 *
 * The e2e installs its fake by (1) triggering the lazy import via the dev hook
 * `window.__drivelineDevHooks.__setFormatAgentEngine`, which `await import`s
 * this barrel and calls `setFormatAgentEngineFactory`, then (2) opening the
 * dialog and running. Because the override is module state in the same chunk the
 * dialog imports, the dialog observes it.
 */

import { ClientOrchestratedEngine, type EngineConfig } from "./engine";
import type { FormatAgentEngine } from "./types";

/** Builds an engine for a given run (only the BYOK key/model are caller-known). */
export type FormatAgentEngineFactory = (
  config: EngineConfig,
) => FormatAgentEngine;

const defaultFactory: FormatAgentEngineFactory = (config) =>
  new ClientOrchestratedEngine(config);

let activeFactory: FormatAgentEngineFactory = defaultFactory;

/** Replace the engine factory (tests inject a fake; production never calls this). */
export function setFormatAgentEngineFactory(
  factory: FormatAgentEngineFactory,
): void {
  activeFactory = factory;
}

/** Restore the default (real-SDK) factory. */
export function resetFormatAgentEngineFactory(): void {
  activeFactory = defaultFactory;
}

/** The factory the dialog uses to build an engine for a run. */
export function getFormatAgentEngineFactory(): FormatAgentEngineFactory {
  return activeFactory;
}
