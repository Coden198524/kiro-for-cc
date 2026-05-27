---
id: start-iteration
name: Start Iteration
version: 1.0.0
description: Run a lightweight iteration session outside the full spec workflow
variables:
  mode:
    type: string
    required: true
    description: Iteration mode identifier
  modeLabel:
    type: string
    required: true
    description: Human readable iteration mode
  modeInstruction:
    type: string
    required: true
    description: Mode-specific behavior rules
  description:
    type: string
    required: true
    description: User's iteration request
  workspacePath:
    type: string
    required: true
    description: Workspace path
  activeFileContext:
    type: string
    required: true
    description: Active editor context
  diagnosticsContext:
    type: string
    required: true
    description: VS Code diagnostics context
  gitContext:
    type: string
    required: true
    description: Git status and diff context
  steeringContext:
    type: string
    required: true
    description: Project context documents
  memoryContext:
    type: string
    required: true
    description: AutoCode memory context
  summaryPath:
    type: string
    required: true
    description: Path where the agent should write an iteration summary
---
<user_input>
I need a lightweight AutoCode iteration session. This is not a full spec workflow.

Iteration mode: {{modeLabel}} ({{mode}})
Workspace path: {{workspacePath}}
Iteration summary path: {{summaryPath}}

User request:

{{description}}

Mode rules:

{{modeInstruction}}

General iteration rules:

1. Detect the user's primary language from the request and use it for terminal progress, explanations, summaries, and generated prose.
2. Keep scope tight. Do not create requirements.md, design.md, tasks.md, or a new spec unless the user explicitly asks for that.
3. Use the provided project context, memory, active file, diagnostics, and git state to reduce repeated repository scanning.
4. If the request is too broad, risky, or design-heavy for a lightweight iteration, explain why and recommend converting it to a Spec workflow.
5. When changing files, preserve existing style and user changes. Do not revert unrelated work.
6. When practical, run the narrowest useful verification command. If verification cannot run, state the blocker clearly.
7. Write a concise Markdown summary to the iteration summary path before you finish. Create parent directories if needed.

Active editor context:

{{{activeFileContext}}}

VS Code diagnostics:

{{{diagnosticsContext}}}

Git context:

{{{gitContext}}}

Project context documents:

{{{steeringContext}}}

AutoCode memory context:

{{{memoryContext}}}
</user_input>
