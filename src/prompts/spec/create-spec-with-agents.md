---
id: create-spec-with-agents
name: Create Spec with Subagents
version: 1.0.0
description: Create a spec using specialized subagents for parallel processing
variables:
  description:
    type: string
    required: true
    description: User's feature description
  workspacePath:
    type: string
    required: true
    description: Workspace root path
  specBasePath:
    type: string
    required: true
    description: Base path for specs directory
  providerName:
    type: string
    required: true
    description: Active agent provider display name
  agentDirectory:
    type: string
    required: true
    description: Directory containing project expert agents
  agentConfigPath:
    type: string
    required: true
    description: Provider-specific expert agent configuration path
  agentInvocationInstruction:
    type: string
    required: true
    description: Provider-specific instructions for invoking or emulating expert agents
---
<user_input>
LAUNCH A SPEC DEVELOPMENT WORKFLOW

Create a requirements document for a new feature.

Feature Description: {{description}}

Workspace path: {{workspacePath}}
Spec base path: {{specBasePath}}
Active provider: {{providerName}}

Expert agent context:

- Agent directory: {{agentDirectory}}
- Agent config path: {{agentConfigPath}}

Provider-specific agent instructions:

{{agentInvocationInstruction}}

Workflow agent mapping:

- Use `spec-requirements` for requirements analysis and requirements.md creation.
- Use `spec-design` for design.md creation after requirements approval.
- Use `spec-tasks` for tasks.md creation after design approval.
- Use `spec-judge` to review whether each document is complete and consistent before asking the user to approve it.
- Use `spec-impl` and `spec-test` only when the user later requests implementation or verification work.

Language and naming rules:

- Detect the primary language of the feature description.
- Use that language for all replies and generated spec document prose unless the user explicitly asks for another language.
- Keep fixed technical tokens such as EARS keywords, file names, code identifiers, API names, and commands in their required technical form.
- Choose a readable kebab-case feature_name that follows the user's language. For English input, use English words such as `user-authentication`; for Chinese input, use pinyin or concise Chinese terms separated by hyphens, such as `yong-hu-ren-zheng`.
- Do not default Chinese or other non-English requests to English-only responses or English-only spec names.

Execution rules:

- Start by creating or updating `{{specBasePath}}/<feature_name>/requirements.md`.
- Include the original Feature Description in your working context; do not ask the user to re-enter it.
- Keep all conversational replies and generated document prose in the detected language.
- After requirements.md is created, ask the user to review and approve it before continuing to design.md.
- You have full control over the naming and file creation.
</user_input>
