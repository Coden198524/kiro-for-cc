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
  agentReadiness:
    type: string
    required: true
    description: Expert agent readiness status verified before launch
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
- Agent readiness: {{agentReadiness}}

Provider-specific agent instructions:

{{agentInvocationInstruction}}

Workflow agent mapping:

- Use `spec-requirements` for requirements analysis and requirements.md creation.
- Use `spec-design` for design.md creation after requirements approval.
- Use `spec-tasks` for tasks.md creation after design approval.
- Use `spec-judge` to review whether each document is complete and consistent before asking the user to approve it.
- Use `spec-impl` and `spec-test` only when the user later requests implementation or verification work.
- Before each phase, explicitly choose native subagent delegation when the runtime exposes it. If native delegation is not exposed, load that agent's file from the configured agent directory and apply its role instructions for the phase.
- Do not silently fall back to a generic assistant role. Briefly report in terminal progress whether the phase used native delegation or file-based instruction emulation.

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
- requirements.md must include testable EARS acceptance criteria, scope, out-of-scope, assumptions / open questions, and non-functional requirements when relevant.
- design.md must include a Requirement Traceability Matrix, clear component contracts, state/error flow coverage, compatibility notes, and a testing strategy mapped to requirements.
- After requirements.md is created, ask the user to review and approve it before continuing to design.md.
- When the workflow reaches tasks.md creation, require every leaf task to include `_Files: ..._`, `_Depends on: none_` or `_Depends on: <task ids>_`, `_Requirements: ..._`, `_Verify: ..._`, and `_Done when: ..._`; dependencies must form a directed acyclic graph so independent tasks can run in parallel.
- Before asking the user to approve each document, run a quality self-check: no untestable requirements, no uncovered requirements in design, no missing task metadata, no dependency cycles, and no unsafe parallel file-scope overlap.
- You have full control over the naming and file creation.
</user_input>
