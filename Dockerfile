# Coolify deploy target: pull the prebuilt image (built off-box by CI from
# Dockerfile.build) instead of running `next build` on the host — an on-box
# build OOM-wedged the shared box on 2026-05-26. This is a near-instant pull.
FROM ghcr.io/torque-labs/agent-jobs:latest
