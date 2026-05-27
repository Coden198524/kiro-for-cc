// Auto-generated from src/prompts/iteration/start-iteration.md
// DO NOT EDIT MANUALLY

export const frontmatter = {
  "id": "start-iteration",
  "name": "Start Iteration",
  "version": "1.0.0",
  "description": "Run a lightweight iteration session outside the full spec workflow",
  "variables": {
    "mode": {
      "type": "string",
      "required": true,
      "description": "Iteration mode identifier"
    },
    "modeLabel": {
      "type": "string",
      "required": true,
      "description": "Human readable iteration mode"
    },
    "modeInstruction": {
      "type": "string",
      "required": true,
      "description": "Mode-specific behavior rules"
    },
    "description": {
      "type": "string",
      "required": true,
      "description": "User's iteration request"
    },
    "workspacePath": {
      "type": "string",
      "required": true,
      "description": "Workspace path"
    },
    "activeFileContext": {
      "type": "string",
      "required": true,
      "description": "Active editor context"
    },
    "diagnosticsContext": {
      "type": "string",
      "required": true,
      "description": "VS Code diagnostics context"
    },
    "gitContext": {
      "type": "string",
      "required": true,
      "description": "Git status and diff context"
    },
    "steeringContext": {
      "type": "string",
      "required": true,
      "description": "Project context documents"
    },
    "memoryContext": {
      "type": "string",
      "required": true,
      "description": "AutoCode memory context"
    },
    "summaryPath": {
      "type": "string",
      "required": true,
      "description": "Path where the agent should write an iteration summary"
    }
  }
};

export const content = "<user_input>\nI need a lightweight AutoCode iteration session. This is not a full spec workflow.\n\nIteration mode: {{modeLabel}} ({{mode}})\nWorkspace path: {{workspacePath}}\nIteration summary path: {{summaryPath}}\n\nUser request:\n\n{{description}}\n\nMode rules:\n\n{{modeInstruction}}\n\nGeneral iteration rules:\n\n1. Detect the user's primary language from the request and use it for terminal progress, explanations, summaries, and generated prose.\n2. Keep scope tight. Do not create requirements.md, design.md, tasks.md, or a new spec unless the user explicitly asks for that.\n3. Use the provided project context, memory, active file, diagnostics, and git state to reduce repeated repository scanning.\n4. If the request is too broad, risky, or design-heavy for a lightweight iteration, explain why and recommend converting it to a Spec workflow.\n5. When changing files, preserve existing style and user changes. Do not revert unrelated work.\n6. When practical, run the narrowest useful verification command. If verification cannot run, state the blocker clearly.\n7. Write a concise Markdown summary to the iteration summary path before you finish. Create parent directories if needed.\n\nActive editor context:\n\n{{{activeFileContext}}}\n\nVS Code diagnostics:\n\n{{{diagnosticsContext}}}\n\nGit context:\n\n{{{gitContext}}}\n\nProject context documents:\n\n{{{steeringContext}}}\n\nAutoCode memory context:\n\n{{{memoryContext}}}\n</user_input>\n";

export default {
  frontmatter,
  content
};
