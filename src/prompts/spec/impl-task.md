---
id: impl-task
name: Implement Task
version: 1.0.0
description: Implement a task after a spec workflow
variables:
  taskFilePath:
    type: string
    required: true
    description: Path for task file
  taskDescription:
    type: string
    required: true
    description: Description for task
  taskMode:
    type: string
    required: true
    description: Execution mode, either start or resume
  taskModeInstruction:
    type: string
    required: true
    description: Mode-specific instructions for the agent
---
<user_input>
I just completed a spec workflow and now need to implement one of the specific tasks.

Task File Path: {{taskFilePath}}
Task Description: {{taskDescription}}
Task Mode: {{taskMode}}

{{taskModeInstruction}}

Please help me:

1. Review the spec workflow guidance if it is available at `.claude/system-prompts/spec-workflow-starter.md`; do not require a Claude-only subagent
2. Review the requirements and design documents in the spec folder
3. Implement this task based on existing codebase patterns and conventions
4. Ensure code quality, including error handling, performance, and security
5. Add or update focused tests for the implemented code
6. When finished, report what changed and what you verified

Task status is managed by the VS Code extension. Do not mark the task as `- [x]` yourself unless the user explicitly asks you to edit task status.
</user_input>
