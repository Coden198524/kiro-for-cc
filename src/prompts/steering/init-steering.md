---
id: init-steering
name: Initialize Project Context
version: 1.0.0
description: Scan the repository and create project context steering documents
variables:
  steeringPath:
    type: string
    required: true
    description: Path where project context steering documents should be created
---

<system>
You are performing project context initialization for an AI coding workflow.

The goal is to scan this repository and create durable project context documents that future spec creation can use before requirements analysis. These are steering documents, but their primary purpose is to ground future AI work in this project's actual product, technology, and structure.

## Required Repository Scan

Before writing files, inspect the repository enough to understand:

- The product domain, primary users, core workflows, and feature boundaries
- The technology stack, build/test/package commands, runtime providers, and important dependencies
- The directory structure, module boundaries, extension points, generated files, and risky shared files
- Existing conventions for naming, state, persistence, task execution, prompts, tests, and UI contributions

Use actual files from the repository as evidence. Do not write generic project advice.

## Writing Guidelines

Write content as direct instructions to future AI agents:

- Use imperative mood ("Use X", "Avoid Y", "Always Z")
- Be specific to this codebase's observed patterns and conventions
- Include concrete file paths and commands when useful
- Capture constraints that prevent over-broad specs or unrelated architecture changes
- Keep the documents concise enough to be read before Create Spec, but complete enough to reduce repeated repository scans

## Required Files

Create exactly these three project context documents by analyzing the codebase:

1. **{{steeringPath}}/product.md**
   - Product purpose and target users
   - Core workflows and user-visible features
   - Product boundaries, out-of-scope areas, and important behavior rules
   - Terms or domain concepts that future specs should preserve

2. **{{steeringPath}}/tech.md**
   - Tech stack, frameworks, package/build tools, and runtime integrations
   - Common commands for install, compile, package, tests, and focused verification
   - Project-specific coding, testing, prompt, and generated-file conventions
   - External tool assumptions and known environment caveats

3. **{{steeringPath}}/structure.md**
   - Directory organization and ownership boundaries
   - Key files for activation, commands, providers, runtime integration, prompts, resources, tests, and assets
   - Data/state flow for specs, tasks, steering, sessions, and settings when present
   - Extension points and shared files that future specs should handle carefully

## Important

- Check if files exist before creating them.
- Do not overwrite existing project context documents. Skip existing files completely.
- Write directly to the filesystem.
- If all required files already exist, report that initialization is already present and summarize any missing context you noticed without modifying files.
- If CLAUDE.md exists, update its "## Steering Documents" section so it points to these project context documents.
</system>

# Initialize Project Context

Analyze this repository and create project context steering documents in the `{{steeringPath}}` directory.

These documents will be read by future Create Spec runs before requirements are drafted. They should help the model stay grounded in this repository's real product shape, technical stack, and architecture instead of expanding a feature request into unrelated generic work.

Create only missing files:

- product.md: Product purpose, users, core workflows, boundaries, and domain rules
- tech.md: Stack, tools, commands, dependencies, conventions, tests, and environment caveats
- structure.md: Directory layout, module responsibilities, key files, data flow, and extension points

IMPORTANT:

1. Inspect the repository first; do not infer from package names alone.
2. Write each missing file directly to the filesystem at the appropriate path in `{{steeringPath}}/`.
3. If a file already exists, do not modify or overwrite it.
4. Keep the content project-specific and useful for later spec requirements analysis.
5. If a project CLAUDE.md exists, create or update the "## Steering Documents" section listing all project context documents with descriptions and paths.
