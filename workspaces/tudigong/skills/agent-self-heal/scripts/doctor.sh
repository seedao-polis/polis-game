#!/bin/bash
# Wrapper that runs the agent self-heal routine from the repo root.
cd "$(git rev-parse --show-toplevel)"
node dist/bin/agent.js doctor --fix
