import { describe, test, expect, beforeAll } from '@jest/globals';
import { PromptLoader } from '../../src/services/promptLoader';

describe('Prompt Integration Tests', () => {
  let promptLoader: PromptLoader;

  beforeAll(() => {
    promptLoader = PromptLoader.getInstance();
    promptLoader.initialize();
  });

  describe('Spec Creation Prompt', () => {
    test('renders spec creation prompt', () => {
      const result = promptLoader.renderPrompt('create-spec', {
        description: 'A user authentication system with OAuth support',
        workspacePath: '/Users/test/my-project',
        specBasePath: '.autocode/specs'
      });

      expect(result).toContain('A user authentication system with OAuth support');
      expect(result).toContain('/Users/test/my-project');
      expect(result).toContain('.autocode/specs');
      expect(result).toContain('<system>');
      expect(result).toContain('spec workflow');
      expect(result).toContain('Requirements');
      expect(result).toContain('Design');
      expect(result).toContain('Tasks');
      expect(result).toContain('_Files:');
      expect(result).toContain('_Depends on:');
      expect(result).toContain('directed acyclic graph');
    });

    test('includes directory creation instruction', () => {
      const result = promptLoader.renderPrompt('create-spec', {
        description: 'test feature',
        workspacePath: '/test',
        specBasePath: '.autocode/specs'
      });

      expect(result).toMatch(/mkdir|create.*directory/i);
      expect(result).toContain('.autocode/specs');
    });

    test('preserves the user language', () => {
      const result = promptLoader.renderPrompt('create-spec', {
        description: 'Add material batch import tool for FlaxEngine',
        workspacePath: '/test',
        specBasePath: '.autocode/specs'
      });

      expect(result).toContain('Detect the user');
      expect(result).toContain('Use that language');
      expect(result).toContain('yong-hu-ren-zheng');
      expect(result).toContain('Add material batch import tool for FlaxEngine');
    });

    test('agent workflow prompt requires DAG task metadata', () => {
      const result = promptLoader.renderPrompt('create-spec-with-agents', {
        description: 'Add task scheduling',
        workspacePath: '/test',
        specBasePath: '.autocode/specs',
        providerName: 'Codex',
        agentDirectory: '/test/.codex/agents',
        agentConfigPath: '/test/.codex/config.toml',
        agentReadiness: 'Codex project expert agents were verified before launch.',
        agentInvocationInstruction: 'Use configured agents.'
      });

      expect(result).toContain('_Files:');
      expect(result).toContain('_Depends on:');
      expect(result).toContain('directed acyclic graph');
    });
  });

  describe('Steering Prompts', () => {
    test('renders init steering prompt', () => {
      const result = promptLoader.renderPrompt('init-steering', {
        steeringPath: '/Users/test/project/.autocode/steering'
      });

      expect(result).toContain('steering documents');
      expect(result).toContain('/Users/test/project/.autocode/steering');
      expect(result).toContain('codebase');
      expect(result).toContain('analyzing');
      expect(result).toContain('patterns');
      expect(result).toContain('conventions');
      expect(result).toContain('file');
      expect(result).toContain('.md');
    });

    test('renders custom steering prompt', () => {
      const result = promptLoader.renderPrompt('create-custom-steering', {
        description: 'Security best practices for API development',
        steeringPath: '/test/project/.autocode/steering'
      });

      expect(result).toContain('Security best practices for API development');
      expect(result).toContain('steering document');
      expect(result).toContain('/test/project/.autocode/steering');
      expect(result).toContain('Choose an appropriate kebab-case filename');
      expect(result).toContain('.md');
    });

    test('renders refine steering prompt', () => {
      const result = promptLoader.renderPrompt('refine-steering', {
        filePath: '/test/project/.autocode/steering/security.md'
      });

      expect(result).toContain('/test/project/.autocode/steering/security.md');
      expect(result).toContain('refine');
      expect(result).toContain('Review and refine');
      expect(result).toContain('clear and direct');
      expect(result).toContain('specific to this project');
      expect(result).toContain('concrete examples');
    });

    test('renders delete steering prompt', () => {
      const result = promptLoader.renderPrompt('delete-steering', {
        documentName: 'security-practices.md',
        steeringPath: '/test/.autocode/steering'
      });

      expect(result).toContain('security-practices.md');
      expect(result).toContain('delete');
      expect(result).toContain('/test/.autocode/steering');
    });
  });

  describe('Prompt Structure Validation', () => {
    test('all prompts include valid frontmatter metadata', () => {
      const allPrompts = promptLoader.listPrompts();

      expect(allPrompts.length).toBeGreaterThan(0);
      allPrompts.forEach(promptMeta => {
        expect(promptMeta.id).toBeTruthy();
        expect(promptMeta.name).toBeTruthy();
        expect(promptMeta.version).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });

    test('all prompts render successfully', () => {
      const testCases = [
        {
          id: 'create-spec',
          variables: {
            description: 'test',
            workspacePath: '/test',
            specBasePath: '.autocode/specs'
          }
        },
        {
          id: 'impl-task',
          variables: {
            taskFilePath: '/test/.autocode/specs/demo/tasks.md',
            taskDescription: '1. Implement demo',
            taskMode: 'resume',
            taskModeInstruction: 'Resume this in-progress task.',
            languagePreference: 'Chinese (中文)',
            languageInstruction: 'Use Chinese (中文) for all conversational responses.',
            completionSignalPath: '/test/.autocode/specs/demo/.autocode/task-completion-1.json',
            providerExecutionGuidance: 'Use focused checks before completion.',
            completionSignalInstruction: 'Write the completion signal when ready.'
          }
        },
        {
          id: 'init-steering',
          variables: {
            steeringPath: '/test/.autocode/steering'
          }
        },
        {
          id: 'create-custom-steering',
          variables: {
            description: 'test',
            steeringPath: '/test/.autocode/steering'
          }
        },
        {
          id: 'refine-steering',
          variables: {
            filePath: '/test/file.md'
          }
        },
        {
          id: 'delete-steering',
          variables: {
            documentName: 'test.md',
            steeringPath: '/test/.autocode/steering'
          }
        }
      ];

      testCases.forEach(({ id, variables }) => {
        expect(() => promptLoader.renderPrompt(id, variables)).not.toThrow();
      });
    });
  });

  describe('Prompt Content Quality', () => {
    test('rendered content does not contain template artifacts', () => {
      const testCases = [
        {
          id: 'create-spec',
          variables: {
            description: 'test feature',
            workspacePath: '/project',
            specBasePath: '.autocode/specs'
          }
        },
        {
          id: 'init-steering',
          variables: {
            steeringPath: '/project/.autocode/steering'
          }
        }
      ];

      testCases.forEach(({ id, variables }) => {
        const result = promptLoader.renderPrompt(id, variables);

        expect(result).not.toContain('{{');
        expect(result).not.toContain('}}');
        expect(result).not.toContain('undefined');
        expect(result).not.toContain('[object Object]');
      });
    });

    test('main workflow prompts preserve expected structure', () => {
      const specPrompt = promptLoader.renderPrompt('create-spec', {
        description: 'test',
        workspacePath: '/test',
        specBasePath: '.autocode/specs'
      });

      const steeringPrompt = promptLoader.renderPrompt('init-steering', {
        steeringPath: '/test/.autocode/steering'
      });

      expect(specPrompt).toMatch(/<system>[\s\S]*<\/system>/);
      expect(steeringPrompt).toMatch(/<system>[\s\S]*<\/system>/);
    });
  });

  describe('Task Implementation Prompt', () => {
    test('includes language preference instructions', () => {
      const result = promptLoader.renderPrompt('impl-task', {
        taskFilePath: '/test/.autocode/specs/demo/tasks.md',
        taskDescription: '1. 实现中文任务',
        taskMode: 'start',
        taskModeInstruction: '从当前 spec 上下文开始执行这个任务。',
        languagePreference: 'Chinese (中文)',
        languageInstruction: 'Use Chinese (中文) for all conversational responses.',
        completionSignalPath: '/test/.autocode/specs/demo/.autocode/task-completion-1.json',
        providerExecutionGuidance: 'Use focused checks before completion.',
        completionSignalInstruction: 'Write the completion signal when ready.'
      });

      expect(result).toContain('Language Preference: Chinese (中文)');
      expect(result).toContain('Language rules:');
      expect(result).toContain('Use Chinese (中文) for all conversational responses.');
      expect(result).toContain('Provider execution guidance:');
      expect(result).toContain('Use focused checks before completion.');
      expect(result).toContain('Completion Signal Path: /test/.autocode/specs/demo/.autocode/task-completion-1.json');
      expect(result).toContain('Completion signal:');
      expect(result).toContain('1. 实现中文任务');
    });
  });
});
