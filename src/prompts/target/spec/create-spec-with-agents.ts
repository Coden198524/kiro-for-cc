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
    "steeringPath": {
      "type": "string",
      "required": true,
      "description": "Project context steering document directory"
    },
    "memoryContext": {
      "type": "string",
      "required": true,
      "description": "Relevant AutoCode memory context for this feature request"
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
    "agentReadiness": {
      "type": "string",
      "required": true,
      "description": "Expert agent readiness status verified before launch"
    },
    "agentInvocationInstruction": {
      "type": "string",
      "required": true,
      "description": "Provider-specific instructions for invoking or emulating expert agents"
    },
    "suggestedFeatureName": {
      "type": "string",
      "required": true,
      "description": "Extension-generated rough feature directory name hint used only as fallback"
    }
  }
};

export const content = "<user_input>\nLAUNCH A SPEC DEVELOPMENT WORKFLOW\n\nCreate a requirements document for a new feature.\n\nFeature Description: {{description}}\n\nWorkspace path: {{workspacePath}}\nSpec base path: {{specBasePath}}\nProject context path: {{steeringPath}}\nRough feature_name hint: {{suggestedFeatureName}}\nActive provider: {{providerName}}\n\nAutoCode memory context:\n\n{{{memoryContext}}}\n\nExpert agent context:\n\n- Agent directory: {{agentDirectory}}\n- Agent config path: {{agentConfigPath}}\n- Agent readiness: {{agentReadiness}}\n\nProvider-specific agent instructions:\n\n{{agentInvocationInstruction}}\n\nWorkflow agent mapping:\n\n- Use `spec-requirements` for requirements analysis and requirements.md creation.\n- Use `spec-design` for design.md creation after requirements approval.\n- Use `spec-tasks` for tasks.md creation after design approval.\n- Use `spec-judge` to review whether each document is complete and consistent before asking the user to approve it.\n- Use `spec-impl` and `spec-test` only when the user later requests implementation or verification work.\n- Before each phase, explicitly choose native subagent delegation when the runtime exposes it. If native delegation is not exposed, load that agent's file from the configured agent directory and apply its role instructions for the phase.\n- Do not silently fall back to a generic assistant role. Briefly report in terminal progress whether the phase used native delegation or file-based instruction emulation.\n\nProject context grounding:\n\n- Before `spec-requirements` drafts requirements, read `{{steeringPath}}/product.md`, `{{steeringPath}}/tech.md`, and `{{steeringPath}}/structure.md` if they exist.\n- Use those documents to constrain scope, identify affected modules, reuse existing conventions, and avoid inventing architecture that does not match this project.\n- If project context documents are missing or incomplete, do a targeted codebase inspection and record missing context as assumptions or open questions in `requirements.md`.\n- Do not broaden the user's request into unrelated platform, product, or architecture work just because the repository has adjacent capabilities.\n\nMemory grounding:\n\n- Use the AutoCode memory context above to preserve user preferences, reuse known project conventions, and avoid previously recorded pitfalls.\n- Treat memory as guidance, not as absolute truth. Current user instructions, current spec documents, and current repository files take precedence over memory.\n\nLanguage and naming rules:\n\n- Detect the primary language of the feature description.\n- Use that language for all replies and generated spec document prose unless the user explicitly asks for another language.\n- Keep fixed technical tokens such as EARS keywords, file names, code identifiers, API names, and commands in their required technical form.\n- Summarize the feature description into a readable feature_name that follows the user's language. The feature_name MUST represent the core intent, not the whole sentence.\n- Do not copy or truncate the full feature description into the directory name.\n- For English input, use English kebab-case words such as `user-authentication`; for Chinese input, the feature_name MUST use concise Chinese terms, optionally separated by hyphens, such as `用户认证` or `用户-认证`.\n- Do not use pinyin for Chinese input unless the user explicitly asks for pinyin. Do not default Chinese or other non-English requests to English-only responses, English-only spec names, or pinyin spec names.\n- Treat the provided rough feature_name hint `{{suggestedFeatureName}}` only as a fallback. Use it only when it already captures the core intent concisely.\n\nExecution rules:\n\n- Start by creating or updating `{{specBasePath}}/<feature_name>/requirements.md`.\n- Ground requirements in the initialized project context from `{{steeringPath}}` before drafting the first version.\n- Include the original Feature Description in your working context; do not ask the user to re-enter it.\n- Keep all conversational replies and generated document prose in the detected language.\n- requirements.md must include testable EARS acceptance criteria, scope, out-of-scope, assumptions / open questions, and non-functional requirements when relevant.\n- design.md must include a Requirement Traceability Matrix, clear component contracts, state/error flow coverage, compatibility notes, and a testing strategy mapped to requirements.\n- After requirements.md is created, ask the user to review and approve it before continuing to design.md.\n- When the workflow reaches tasks.md creation, require every leaf task to include `_Files: ..._`, `_Depends on: none_` or `_Depends on: <task ids>_`, `_Requirements: ..._`, `_Verify: ..._`, and `_Done when: ..._`; dependencies must form a directed acyclic graph so independent tasks can run in parallel.\n- Before asking the user to approve each document, run a quality self-check: no untestable requirements, no uncovered requirements in design, no missing task metadata, no dependency cycles, and no unsafe parallel file-scope overlap.\n- You have full control over the naming and file creation.\n</user_input>\n";

export default {
  frontmatter,
  content
};
