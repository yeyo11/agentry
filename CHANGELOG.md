# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

Everything so far. The first tagged release will start this section off.

### Added

- Runs driven entirely through the Claude Code CLI: detection, auth status, multi-turn
  conversations over stream-json with transparent `--resume`, token streaming, background tasks
  and subagents.
- Session and project history read from the CLI's own transcripts, with every session attributed
  to its origin (CLI, wrapper run, orchestration worker).
- Orchestration: a DAG of tasks with parallelism, dependency context, a synthesis step and an
  auto-planner.
- Multi-account support through claude-swap, with usage per window, a proactive rotation
  supervisor, rotate-and-resume for a run that dies against its limit, and per-run account pinning.
- The full per-account configuration surface: settings, instructions, MCP servers, agents, skills,
  commands, output styles, rules, a confined file explorer, memory, plugins and marketplaces.
- An embedded SQLite store for everything that accumulates — rotation history, runs and
  orchestrations — so history survives a restart and two processes sharing a data dir no longer
  overwrite each other's records.
- REST API documented with an OpenAPI 3.1 document generated from the shared types and served
  with Scalar at `/docs`, plus a test that fails if a route is undocumented.
- Web UI with a command palette, light/dark/system themes, CodeMirror editors, unsaved-change
  guards and a responsive layout.
- Unit, API integration and headless-browser test suites, and a single non-root Docker image with
  the CLI baked in.
