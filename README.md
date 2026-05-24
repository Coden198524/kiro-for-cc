# AutoCode

[![Visual Studio Marketplace](https://img.shields.io/vscode-marketplace/v/heisebaiyun.kiro-for-cc.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=heisebaiyun.kiro-for-cc)
[![Downloads](https://img.shields.io/vscode-marketplace/d/heisebaiyun.kiro-for-cc.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=heisebaiyun.kiro-for-cc)
[![GitHub stars](https://img.shields.io/github/stars/notdp/kiro-for-cc.svg?style=flat-square)](https://github.com/notdp/kiro-for-cc/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/notdp/kiro-for-cc.svg?style=flat-square)](https://github.com/notdp/kiro-for-cc/issues)

[中文版](./README.zh-CN.md)

> [!IMPORTANT]
> **🎉 New: Sub Agent Support Now Available!**  
> Enhanced Claude Code workflow capabilities through Sub Agent feature. Create specs with parallel processing using specialized agents for requirements, design, and tasks.

A VSCode extension that brings spec-driven development to Claude Code. Manage your specs and steering documents visually while leveraging Claude Code's powerful AI capabilities.

**NEW: Create SPEC with Sub Agents:**

1. Click the AutoCode icon in the activity bar
2. In the SPEC view header, click the "New Spec with Agents" button (with sparkle icon ✨)
3. Enter a feature description
4. Claude will automatically:
   - Load the spec workflow system prompt
   - Delegate work to specialized agents (requirements, design, tasks)
   - Process each phase in parallel with dedicated context windows
5. Review outputs as agents complete their work

<p align="center">
  <img src="screenshots/new-spec-with-agents.png" width="600" alt="New Spec with Agents">
</p>

> **Note**: Sub agents may occasionally experience longer execution times due to a known bug. To maintain compatibility, both the original (`+` button) and new Sub Agent methods are available. The traditional method remains stable if you encounter any issues.

## Features

### 📝 SPEC Management

- **Create Specs**: Generate requirements, design, and task documents with Claude's help
- **Visual Explorer**: Browse and manage specs in the sidebar
- **Spec Workflow**: Requirements → Design → Tasks with review at each step
- **NEW: Sub Agent Support**: Create specs using specialized agents for parallel processing

### 🤖 AGENT Management

- **User & Project Agents**: View and manage Claude Code agents at user and project levels
- **Built-in Agents**: Pre-configured spec workflow agents (requirements, design, tasks, judge, etc.)
- **Agent Explorer**: Browse and edit agent configurations with syntax highlighting

### 🎯 STEERING Management

- **CLAUDE.md**: Browse and edit global/project-specific guidelines
- **Generated Docs**: Product, tech, and structure steering documents

### 🔌 MCP Management

- **MCP Servers**: View configured global and workspace MCP servers

### 🪝 HOOKS Management

- **Agent Hooks**: View Claude Code hooks

### ⚙️ Others

- **Settings Management**: Centralized configuration

## Screenshot

![AutoCode Extension](./screenshots/image.png)

*The extension provides a comprehensive sidebar interface with organized views for specs, steering documents, MCP servers, and hooks management. All your Claude Code enhancement tools in one place.*

## Installation

### Prerequisites

1. **Claude Code Installation**: Ensure Claude Code is installed and configured

2. **Compatibility**:

| Platform                  | Support | Notes                                    | Status   |
| ------------------------- | ------- | ---------------------------------------- | -------- |
| macOS                     | ✅       | Fully supported                          | released |
| Linux                     | ✅       | Fully supported                          | released |
| Windows (WSL)             | ✅       | Supported with automatic path conversion | released |
| Windows (CMD)             | ❌       | Not supported                            | TBD      |
| Windows (PowerShell)      | ❌       | Not supported                            | TBD      |
| Windows (MinTTY Git Bash) | ❌       | Not supported                            | TBD      |

### From Extension Marketplace

**VSCode users:**

1. Open VSCode
2. Go to Extensions (Cmd+Shift+X)
3. Search for "AutoCode"
4. Click Install

Or via command line:

```bash
code --install-extension heisebaiyun.kiro-for-cc
```

**Cursor users:**
The extension is available on OpenVSX Registry. In Cursor:

1. Go to Extensions
2. Search for "AutoCode"
3. Click Install

Or via command line:

```bash
cursor --install-extension heisebaiyun.kiro-for-cc
```

### From VSIX file

Download the latest `.vsix` file from [GitHub Releases](https://github.com/notdp/kiro-for-cc/releases/latest), then:

```bash
# VSCode
code --install-extension kiro-for-cc-{latest-version}.vsix

# Cursor
cursor --install-extension kiro-for-cc-{latest-version}.vsix
```

Replace `{latest-version}` with the actual version number, e.g., `0.2.4`.

## Usage

### Creating a Spec

**Traditional Method:**
1. Click the AutoCode icon in the activity bar
2. In the SPEC view, click the `+` button
3. Enter a feature description
4. Claude will generate the requirements document
5. Review and approve before proceeding to design
6. Generate tasks after design is complete

### Spec Workflow

1. **Requirements**: Define what you want to build
2. **Design**: Create technical design after requirements approval
3. **Tasks**: Generate implementation tasks after design approval
4. **Implementation**: Execute tasks one by one

### Steering Documents

Create project-specific guidance:

- Click ✨ icon to create custom steering
- Generate initial docs (product, tech, structure)
- Documents are stored in `.autocode/steering/`

## Configuration

Settings are stored in `.autocode/settings/autocode-settings.json`:

```json
{
  "paths": {
    "specs": ".autocode/specs",
    "steering": ".autocode/steering",
    "settings": ".autocode/settings"
  },
  "views": {
    "specs": {
      "visible": true
    },
    "steering": {
      "visible": true
    },
    "mcp": {
      "visible": true
    },
    "hooks": {
      "visible": true
    },
    "settings": {
      "visible": false
    }
  }
}
```

## Workspace Structure

The extension creates the following structure in your workspace:

```plain
.autocode/                    # Extension data directory
├── specs/                    # Feature specifications
│   └── {spec-name}/
│       ├── requirements.md   # What to build
│       ├── design.md        # How to build
│       └── tasks.md         # Implementation steps
├── agents/                  # Claude Code agents
│   └── kfc/                 # Built-in agents (auto-initialized)
│       ├── spec-requirements.md
│       ├── spec-design.md
│       ├── spec-tasks.md
│       ├── spec-judge.md
│       ├── spec-impl.md
│       ├── spec-test.md
│       └── spec-system-prompt-loader.md
├── steering/                # AI guidance documents
│   ├── product.md          # Product conventions
│   ├── tech.md             # Technical standards
│   └── structure.md        # Code organization
├── settings/
│   └── autocode-settings.json # Extension settings
```

## Development

### Prerequisites

- Node.js 16+
- VSCode 1.84.0+
- TypeScript 5.3.0+

### Setup

```bash
# Clone the repository
git clone https://github.com/notdp/kiro-for-cc.git
cd kiro-for-cc

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-compile on changes)
npm run watch
```

### Running the Extension

1. Open the project in VSCode
2. Press `F5` to launch Extension Development Host
3. The extension will be available in the new VSCode window

### Building

```bash
# Build VSIX package
npm run package

# Output: kiro-for-cc-{latest-version}.vsix
```

### Project Structure

```plain
src/
├── extension.ts              # Extension entry point, command registration
├── constants.ts              # Configuration constants
├── features/                 # Business logic
│   ├── spec/
│   │   └── specManager.ts    # Spec lifecycle management
│   ├── steering/
│   │   └── steeringManager.ts # Steering document management
│   └── agents/
│       └── agentManager.ts   # Agent initialization and management
├── providers/                # VSCode TreeDataProviders
│   ├── claudeCodeProvider.ts # Claude CLI integration
│   ├── specExplorerProvider.ts
│   ├── steeringExplorerProvider.ts
│   ├── agentsExplorerProvider.ts    # NEW: Agent explorer
│   ├── hooksExplorerProvider.ts
│   ├── mcpExplorerProvider.ts
│   └── overviewProvider.ts
├── prompts/                  # AI prompt templates
│   ├── specPrompts.ts        # Spec generation prompts
│   ├── steeringPrompts.ts    # Steering doc prompts
│   └── spec/
│       └── create-spec-with-agents.md # NEW: Sub agent workflow
├── resources/                # Built-in resources
│   ├── agents/              # Pre-configured agents
│   └── prompts/             # System prompts
└── utils/
    └── configManager.ts      # Configuration management
```

### Key Architecture Concepts

- **Manager Pattern**: Each feature has a Manager class handling business logic
- **Provider Pattern**: Tree views extend `vscode.TreeDataProvider`
- **Command Pattern**: All commands follow `kfc.{feature}.{action}` naming
- **Configuration**: Centralized through `ConfigManager` for flexibility

## License

MIT License - see [LICENSE](./LICENSE) for details
