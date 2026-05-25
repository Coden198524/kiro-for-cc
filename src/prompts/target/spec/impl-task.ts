// Auto-generated from src/prompts/spec/impl-task.md
// DO NOT EDIT MANUALLY

export const frontmatter = {
  "id": "impl-task",
  "name": "Implement Task",
  "version": "1.0.0",
  "description": "Implement a task after a spec workflow",
  "variables": {
    "taskFilePath": {
      "type": "string",
      "required": true,
      "description": "Path for task file"
    },
    "taskDescription": {
      "type": "string",
      "required": true,
      "description": "Description for task"
    },
    "taskMode": {
      "type": "string",
      "required": true,
      "description": "Execution mode, either start or resume"
    },
    "taskModeInstruction": {
      "type": "string",
      "required": true,
      "description": "Mode-specific instructions for the agent"
    },
    "languagePreference": {
      "type": "string",
      "required": true,
      "description": "Language to use for responses and generated prose"
    },
    "languageInstruction": {
      "type": "string",
      "required": true,
      "description": "Language-specific response instructions"
    },
    "providerExecutionGuidance": {
      "type": "string",
      "required": true,
      "description": "Provider-specific execution quality and speed guidance"
    },
    "completionSignalPath": {
      "type": "string",
      "required": true,
      "description": "Path to write when the task is ready for verification"
    },
    "completionSignalInstruction": {
      "type": "string",
      "required": true,
      "description": "Instructions for signaling task completion"
    }
  }
};

export const content = "<user_input>\nI just completed a spec workflow and now need to implement one of the specific tasks.\n\nTask File Path: {{taskFilePath}}\nTask Description: {{taskDescription}}\nTask Mode: {{taskMode}}\nLanguage Preference: {{languagePreference}}\nCompletion Signal Path: {{completionSignalPath}}\n\n{{taskModeInstruction}}\n\nLanguage rules:\n\n{{languageInstruction}}\n\nProvider execution guidance:\n\n{{providerExecutionGuidance}}\n\nPlease help me:\n\n1. Review the spec workflow guidance if it is available at `.autocode/system-prompts/spec-workflow-starter.md`; do not require a Claude-only subagent\n2. Review the requirements and design documents in the spec folder\n3. Implement this task based on existing codebase patterns and conventions\n4. Ensure code quality, including error handling, performance, and security\n5. Add or update focused tests for the implemented code\n6. When finished, report what changed and what you verified in the language specified above\n\nCompletion signal:\n\n{{{completionSignalInstruction}}}\n\nTask status is managed by the VS Code extension. Do not mark the task as `- [x]` yourself unless the user explicitly asks you to edit task status.\n</user_input>\n";

export default {
  frontmatter,
  content
};
