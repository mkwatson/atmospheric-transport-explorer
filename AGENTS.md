# Atmospheric Transport Explorer

This repository follows the nine Engineering Principles supplied by the project owner and the *AI-Native Shift-Left Doctrine*. The governing rule is: put each invariant in the earliest authoritative mechanism that can enforce it faithfully.

## Product contract

- Build a client-only public experience. The core experience must require no account, login, API key, secret, paid plan, or user signup.
- Do not add an application backend, database, authentication, queue, scheduled job, or server-owned proxy without an explicit product decision. A hosting adapter does not make server behavior part of the application.
- Open on the contiguous United States with an immediately legible, animated high-level wind field. The atmospheric canvas is the product, not a backdrop behind controls.
- Direct manipulation is primary: drag, rotate, zoom, play/pause, and scrub. Keep permanent controls minimal and disclose precision controls only when the user asks for them.
- Loading, empty, and failure states must leave an understandable map visible. Never ship a blank central canvas.
- Start with the ambient national wind story. Point-specific provenance or backward trajectories are a deliberate secondary mode, not the first screen.

## Scientific contract

- Say exactly what is shown: model forecast or analysis, valid time, altitude or pressure level, units, and data source.
- Keep instantaneous wind fields, streamlines, pathlines, and backward trajectories conceptually and visually distinct.
- Never label a browser-integrated kinematic estimate as HYSPLIT or imply observation-grade provenance. Imported authoritative trajectories must retain their source identity.
- Do not imply precision the source data, sampling interval, interpolation, or model cannot support.
- Keep attribution and a concise limitations explanation accessible without competing with the primary experience.

## Minimum-complexity architecture

- Prefer one map engine, one wind renderer, one primary weather-data source, and platform/browser primitives.
- Prefer a maintained library's supported path and defaults over custom shaders, render loops, projection math, decoders, adapters, or abstraction layers.
- Before adopting a meaningful dependency, check its official documentation and prove the narrow real-data path in the browser. Evaluate browser support, bundle cost, licensing/attribution, WebGL compatibility, maintenance, and whether it requires credentials.
- Do not preserve starter code, starter tests, or optional backend packages merely because they already exist.
- Do not introduce an abstraction until two real callers or implementations need it.
- Prefer pure functions, readonly values, discriminated unions, and `map`/`filter`/`reduce`. Contain mutation inside an imperative boundary or a measured rendering hot path and state why it is needed.

## Trust boundaries

- Treat URL parameters, geolocation, browser storage, imported files, and every third-party response as `unknown`.
- Parse each boundary once into a trusted domain value. Zod is the default for structured external data; do not cast raw JSON into a trusted type or scatter re-validation downstream.
- Keep network access, MapLibre calls, browser APIs, animation scheduling, and storage in a thin imperative shell.
- Keep wind-vector conversion, interpolation, timeline math, grid construction, trajectory integration, and display formatting in a functional core with explicit inputs and outputs.

## Enforcement ladder

For every requirement, defect, or repeated review comment, use the first layer that has enough information and authority:

1. Make invalid states impossible with narrow domain types, discriminated unions, readonly data, and exhaustive handling.
2. Parse untrusted inputs into trusted values at the boundary.
3. Reject forbidden source statically with TypeScript, ESLint, dependency rules, or build-time checks.
4. Reshape entangled code into a functional core and imperative shell.
5. Add a fast deterministic behavior test only when execution is required to prove the invariant.
6. Add a focused real-boundary check for third-party schemas or rendering adapters.
7. Keep browser end-to-end coverage to the smallest critical journey needed to prove assembled wiring.
8. Use runtime fallback and observation only for facts that cannot be known earlier.

Do not duplicate a guarantee in a later layer without a distinct blind spot. Do not pursue coverage targets. Tests must be fast, deterministic, hermetic, behavior-focused, and precise; avoid mocks unless the interaction itself is the contract.

## Working agreement

- Discover before consequential implementation decisions, using official documentation and recent primary sources.
- Make the smallest complete change that advances the current experience. Avoid speculative options, compatibility layers, defensive branches for impossible cases, and premature configuration.
- Run `npm run lint` and `npm run build` for implementation changes. Run focused tests only when the changed behavior has a test whose layer is justified above.
- When a defect escapes or a review comment repeats, identify the earliest authoritative prevention layer, strengthen it, and remove redundant downstream checks.
- Keep going: resolve routine in-scope details from evidence and defaults rather than stopping for ceremony.

This file records intent and decision rules. It is not proof by itself. Critical invariants should move into types, parsers, static checks, builds, or focused tests as soon as the implementation makes that enforcement useful and reliable.
