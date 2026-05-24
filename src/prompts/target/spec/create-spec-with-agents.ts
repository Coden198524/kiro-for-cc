// Auto-generated from src/prompts/spec/create-spec-with-agents.md
// DO NOT EDIT MANUALLY

export const frontmatter = {
  "id": "create-spec-with-agents",
  "name": "Create Spec with Subagents",
  "version": "1.0.0",
  "description": "Create a spec using specialized subagents for parallel processing",
  "variables": {
    "description": {
      "type": "string",
      "required": true,
      "description": "User's feature description"
    },
    "workspacePath": {
      "type": "string",
      "required": true,
      "description": "Workspace root path"
    },
    "specBasePath": {
      "type": "string",
      "required": true,
      "description": "Base path for specs directory"
    },
    "providerName": {
      "type": "string",
      "required": true,
      "description": "Active agent provider display name"
    },
    "agentDirectory": {
      "type": "string",
      "required": true,
      "description": "Directory containing project expert agents"
    },
    "agentConfigPath": {
      "type": "string",
      "required": true,
      "description": "Provider-specific expert agent configuration path"
    },
    "agentInvocationInstruction": {
      "type": "string",
      "required": true,
      "description": "Provider-specific instructions for invoking or emulating expert agents"
    }
  }
};

export const content = "<user_input>\nLAUNCH A SPEC DEVELOPMENT WORKFLOW\n\nCreate a requirements document for a new feature.\n\nFeature Description: {{description}}\n\nWorkspace path: {{workspacePath}}\nSpec base path: {{specBasePath}}\nActive provider: {{providerName}}\n\nExpert agent context:\n\n- Agent directory: {{agentDirectory}}\n- Agent config path: {{agentConfigPath}}\n\nProvider-specific agent instructions:\n\n{{agentInvocationInstruction}}\n\nWorkflow agent mapping:\n\n- Use `spec-requirements` for requirements analysis and requirements.md creation.\n- Use `spec-design` for design.md creation after requirements approval.\n- Use `spec-tasks` for tasks.md creation after design approval.\n- Use `spec-judge` to review whether each document is complete and consistent before asking the user to approve it.\n- Use `spec-impl` and `spec-test` only when the user later requests implementation or verification work.\n\nLanguage and naming rules:\n\n- Detect the primary language of the feature description.\n- Use that language for all replies and generated spec document prose unless the user explicitly asks for another language.\n- Keep fixed technical tokens such as EARS keywords, file names, code identifiers, API names, and commands in their required technical form.\n- Choose a readable kebab-case feature_name that follows the user's language. For English input, use English words such as `user-authentication`; for Chinese input, use pinyin or concise Chinese terms separated by hyphens, such as `yong-hu-ren-zheng`.\n- Do not default Chinese or other non-English requests to English-only responses or English-only spec names.\n\nExecution rules:\n\n- Start by creating or updating `{{specBasePath}}/<feature_name>/requirements.md`.\n- Include the original Feature Description in your working context; do not ask the user to re-enter it.\n- Keep all conversational replies and generated document prose in the detected language.\n- After requirements.md is created, ask the user to review and approve it before continuing to design.md.\n- You have full control over the naming and file creation.\n</user_input>\n";

export default {
  frontmatter,
  content
};
