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
  steeringPath:
    type: string
    required: true
    description: Project context steering document directory
  memoryContext:
    type: string
    required: true
    description: Relevant AutoCode memory context for this feature request
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
  suggestedFeatureName:
    type: string
    required: true
    description: Extension-generated rough feature directory name hint used only as fallback
---
<user_input>
LAUNCH A SPEC DEVELOPMENT WORKFLOW

Create a requirements document for a new feature.

Feature Description: {{description}}

Workspace path: {{workspacePath}}
Spec base path: {{specBasePath}}
Project context path: {{steeringPath}}
Rough feature_name hint: {{suggestedFeatureName}}
Active provider: {{providerName}}

AutoCode memory context:

{{{memoryContext}}}

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

Project context grounding:

- Before `spec-requirements` drafts requirements, read `{{steeringPath}}/product.md`, `{{steeringPath}}/tech.md`, and `{{steeringPath}}/structure.md` if they exist.
- Use those documents to constrain scope, identify affected modules, reuse existing conventions, and avoid inventing architecture that does not match this project.
- If project context documents are missing or incomplete, do a targeted codebase inspection and record missing context as assumptions or open questions in `requirements.md`.
- Do not broaden the user's request into unrelated platform, product, or architecture work just because the repository has adjacent capabilities.

Memory grounding:

- Use the AutoCode memory context above to preserve user preferences, reuse known project conventions, and avoid previously recorded pitfalls.
- Treat memory as guidance, not as absolute truth. Current user instructions, current spec documents, and current repository files take precedence over memory.

Language and naming rules:

- Detect the primary language of the feature description.
- Use that language for all replies and generated spec document prose unless the user explicitly asks for another language.
- Keep fixed technical tokens such as EARS keywords, file names, code identifiers, API names, and commands in their required technical form.
- Summarize the feature description into a readable feature_name that follows the user's language. The feature_name MUST represent the core intent, not the whole sentence.
- Do not copy or truncate the full feature description into the directory name.
- For English input, use English kebab-case words such as `user-authentication`; for Chinese input, the feature_name MUST use concise Chinese terms, optionally separated by hyphens, such as `用户认证` or `用户-认证`.
- Do not use pinyin for Chinese input unless the user explicitly asks for pinyin. Do not default Chinese or other non-English requests to English-only responses, English-only spec names, or pinyin spec names.
- Treat the provided rough feature_name hint `{{suggestedFeatureName}}` only as a fallback. Use it only when it already captures the core intent concisely.

Execution rules:

- Start by creating or updating `{{specBasePath}}/<feature_name>/requirements.md`.
- Ground requirements in the initialized project context from `{{steeringPath}}` before drafting the first version.
- Include the original Feature Description in your working context; do not ask the user to re-enter it.
- Keep all conversational replies and generated document prose in the detected language.
- requirements.md must include testable EARS acceptance criteria, scope, out-of-scope, assumptions / open questions, and non-functional requirements when relevant.
- design.md must include a Requirement Traceability Matrix, clear component contracts, state/error flow coverage, compatibility notes, and a testing strategy mapped to requirements.
- After requirements.md is created, ask the user to review and approve it before continuing to design.md.
- When the workflow reaches tasks.md creation, require every leaf task to include `_Files: ..._`, `_Depends on: none_` or `_Depends on: <task ids>_`, `_Requirements: ..._`, `_Verify: ..._`, and `_Done when: ..._`; dependencies must form a directed acyclic graph so independent tasks can run in parallel.
- Before asking the user to approve each document, run a quality self-check: no untestable requirements, no uncovered requirements in design, no missing task metadata, no dependency cycles, and no unsafe parallel file-scope overlap.
- You have full control over the naming and file creation.
</user_input>
