# Agent MCP Server Implementation Plan

## Goal

Extend AutoCode from a Claude-only terminal integration into a multi-provider Agent Runtime that can run Claude, Codex/OpenAI, DeepSeek, GLM/Z.AI, and custom OpenAI-compatible models. The VS Code extension should remain the UI and workspace integration layer; provider selection, command construction, agent capability mapping, and MCP server discovery should move behind a runtime abstraction.

## Reference Architecture

The design follows the same boundaries used in `E:\Work\Aperant`:

- Provider factory: model/provider detection and per-provider execution differences.
- Agent config registry: maps agent type to allowed tools, MCP servers, and default thinking level.
- MCP registry/client: resolves built-in and custom MCP servers, supporting stdio and HTTP transports.
- Tool registry: exposes only the tools allowed for the active agent.

## Target Modules

```plain
src/runtime/
  agentRuntime.ts          # Runtime interface
  terminalAgentRuntime.ts  # CLI-backed implementation
  providerRegistry.ts      # claude/codex/deepseek/glm/custom command builders
  runtimeSettings.ts       # VS Code + project settings resolution
  agentConfigs.ts          # spec/steering/task agent capability mapping
  mcpRegistry.ts           # built-in and custom MCP server definitions
  mcpStatusService.ts      # status data for the MCP tree
```

## Provider Strategy

Initial implementation uses CLI-backed providers so current terminal workflows keep working and no new SDK dependencies are required.

- `claude`: preserves `claude --permission-mode bypassPermissions`.
- `codex`: runs the configured Codex/OpenAI CLI command.
- `deepseek`: runs the configured DeepSeek CLI command.
- `glm`: runs the configured GLM/Z.AI CLI command.
- `custom`: uses a user-supplied command template.

Future work can add an AI SDK runtime behind the same `AgentRuntime` interface for direct API calls, streaming, and richer tool execution.

## MCP Strategy

The extension should stop treating MCP as `claude mcp list` only. A runtime-owned MCP registry should expose:

- Built-ins: `context7`, `puppeteer`, `electron`.
- Claude compatibility: existing Claude MCP servers parsed from `claude mcp list` when active provider is Claude.
- Custom servers from `autocode-settings.json`.

This keeps Claude compatibility while allowing non-Claude providers to see and use extension-level MCP configuration.

## Implementation Phases

1. Add the plan document and runtime interfaces.
2. Wrap the existing Claude path in `TerminalAgentRuntime`.
3. Move `SpecManager` and `SteeringManager` to the runtime interface.
4. Add provider/model/MCP config to project settings and VS Code settings.
5. Replace MCP tree data loading with `McpStatusService`.
6. Mark Agents/Hooks/Claude permission features as Claude-only unless an equivalent runtime capability exists.
7. Add tests for provider command generation, runtime routing, and MCP status resolution.

## First Release Scope

The first release should support spec creation, steering creation/refinement, steering delete follow-up, and task implementation across Claude, Codex, DeepSeek, GLM, and custom CLI providers. Claude-only views remain available for Claude but should be clearly labeled when another provider is selected.

## Current Implementation Notes

- Runtime calls now carry an agent type so the terminal runtime can append provider, tool, thinking level, and MCP context from `agentConfigs.ts`.
- `Create Spec with Agents` uses Claude subagents only when the active provider supports Claude agents; other providers fall back to the standard spec workflow.
- Project settings are merged and written back on startup/open so existing `autocode-settings.json` files receive new provider, MCP, and view defaults without losing custom values. Legacy `kfc-settings.json` files are still read for migration.
- MCP support is currently configuration and prompt-context based for non-Claude CLIs. Direct MCP process mediation remains future work because Codex, DeepSeek, GLM, and custom CLIs expose MCP/tooling differently.
