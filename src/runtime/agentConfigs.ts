export type AgentType =
    | 'spec_orchestrator'
    | 'spec_with_agents'
    | 'steering_writer'
    | 'steering_initializer'
    | 'steering_refiner'
    | 'steering_deleter'
    | 'task_implementer';

export interface AgentConfig {
    agentType: AgentType;
    displayName: string;
    tools: readonly string[];
    mcpServers: readonly string[];
    defaultModelRole: 'fast' | 'balanced' | 'strong';
    thinkingDefault: 'low' | 'medium' | 'high';
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const WRITE_DOC_TOOLS = ['write_spec_document', 'write_steering_document'] as const;
const CODE_TOOLS = ['Write', 'Edit', 'Bash'] as const;

export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
    spec_orchestrator: {
        agentType: 'spec_orchestrator',
        displayName: 'Spec Orchestrator',
        tools: [...READ_TOOLS, ...WRITE_DOC_TOOLS, 'WebFetch', 'WebSearch'],
        mcpServers: ['context7'],
        defaultModelRole: 'balanced',
        thinkingDefault: 'medium'
    },
    spec_with_agents: {
        agentType: 'spec_with_agents',
        displayName: 'Spec Agent Orchestrator',
        tools: [...READ_TOOLS, ...WRITE_DOC_TOOLS, 'WebFetch', 'WebSearch', 'SpawnSubagent'],
        mcpServers: ['context7'],
        defaultModelRole: 'strong',
        thinkingDefault: 'high'
    },
    steering_writer: {
        agentType: 'steering_writer',
        displayName: 'Steering Writer',
        tools: [...READ_TOOLS, 'write_steering_document'],
        mcpServers: ['context7'],
        defaultModelRole: 'balanced',
        thinkingDefault: 'medium'
    },
    steering_initializer: {
        agentType: 'steering_initializer',
        displayName: 'Steering Initializer',
        tools: [...READ_TOOLS, 'write_steering_document'],
        mcpServers: ['context7'],
        defaultModelRole: 'balanced',
        thinkingDefault: 'medium'
    },
    steering_refiner: {
        agentType: 'steering_refiner',
        displayName: 'Steering Refiner',
        tools: [...READ_TOOLS, 'write_steering_document'],
        mcpServers: ['context7'],
        defaultModelRole: 'balanced',
        thinkingDefault: 'medium'
    },
    steering_deleter: {
        agentType: 'steering_deleter',
        displayName: 'Steering Deleter',
        tools: [...READ_TOOLS, 'write_steering_document'],
        mcpServers: [],
        defaultModelRole: 'fast',
        thinkingDefault: 'low'
    },
    task_implementer: {
        agentType: 'task_implementer',
        displayName: 'Task Implementer',
        tools: [...READ_TOOLS, ...CODE_TOOLS],
        mcpServers: ['context7'],
        defaultModelRole: 'strong',
        thinkingDefault: 'high'
    }
};

export function getAgentConfig(agentType: AgentType): AgentConfig {
    return AGENT_CONFIGS[agentType];
}
