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
---
<user_input>
LAUNCH A SPEC DEVELOPMENT WORKFLOW

Create a requirements document for a new feature

Feature Description: {{description}}

Workspace path: {{workspacePath}}
Spec base path: {{specBasePath}}

Language and naming rules:

- Detect the primary language of the feature description.
- Use that language for all replies and generated spec document prose unless the user explicitly asks for another language.
- Keep fixed technical tokens such as EARS keywords, file names, code identifiers, API names, and commands in their required technical form.
- Choose a readable kebab-case feature_name that follows the user's language. For English input, use English words such as "user-authentication"; for Chinese input, use pinyin or concise Chinese terms separated by hyphens, such as "yong-hu-ren-zheng" or "用户-认证".
- Do not default Chinese or other non-English requests to English-only responses or English-only spec names.

You have full control over the naming and file creation.
</user_input>
