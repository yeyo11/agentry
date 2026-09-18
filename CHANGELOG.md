# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please) from the
commit messages. Do not edit it by hand.

## 0.1.0 (2026-09-18)

### Features

* Runs driven entirely through the Claude Code CLI: detection, auth status, multi-turn
  conversations over stream-json with transparent `--resume`, token streaming, background tasks
  and subagents.
* Session and project history read from the CLI's own transcripts, with every session attributed
  to its origin (CLI, Agentry run, orchestration worker).
* Orchestration: a DAG of tasks with parallelism, dependency context, a synthesis step and an
  auto-planner.
* Multi-account support through claude-swap, with usage per window, a proactive rotation
  supervisor, rotate-and-resume for a run that dies against its limit, and per-run account pinning.
* The full per-account configuration surface: settings, instructions, MCP servers, agents, skills,
  commands, output styles, rules, a confined file explorer, memory, plugins and marketplaces.
* An embedded SQLite store for everything that accumulates — rotation history, runs and
  orchestrations — so history survives a restart and two processes sharing a data dir no longer
  overwrite each other's records.
* REST API documented with an OpenAPI 3.1 document generated from the shared types and served
  with Scalar at `/docs`, plus a test that fails if a route is undocumented.
* Web UI with a command palette, light/dark/system themes, CodeMirror editors, unsaved-change
  guards and a responsive layout.

### Build and packaging

* Single non-root Docker image with the CLI baked in, published to `ghcr.io/yeyo11/agentry`.
* Unit, API integration and headless-browser test suites run on every push.
