# Visual verification fixture

This loopback-only app supplies deterministic success, loading, responsive, and intentional failure
states for runtime and cross-harness E2E tests. The canonical scenarios are declared in
`.openinspect/verification.yaml`; `/failure` is reserved for negative-path tests.
