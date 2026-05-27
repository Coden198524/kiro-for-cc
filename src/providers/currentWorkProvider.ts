import * as vscode from 'vscode';
import { AutoTaskQueueRecoveryRecord, AutoTaskQueueTaskState, findRecoverableAutoTaskQueues, getAutoTaskQueueSummary } from '../features/spec/taskQueueController';
import { ConfigManager } from '../utils/configManager';
import { localize } from '../utils/localization';

type CurrentWorkItemKind = 'action' | 'empty' | 'queue' | 'queue-detail';

export class CurrentWorkProvider implements vscode.TreeDataProvider<CurrentWorkItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<CurrentWorkItem | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private outputChannel: vscode.OutputChannel) { }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: CurrentWorkItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CurrentWorkItem): Promise<CurrentWorkItem[]> {
        if (element?.queue) {
            return this.getQueueChildren(element.queue);
        }

        if (element) {
            return [];
        }

        const queues = await this.getQueues();
        const rootItems: CurrentWorkItem[] = [
            this.createActionItem(
                localize('Development Speed Preset', '开发速度预设'),
                'autocode.settings.selectDevelopmentSpeedPreset',
                'rocket'
            )
        ];

        if (queues.length === 0) {
            rootItems.push(new CurrentWorkItem(
                localize('No active task queue', '没有正在运行的任务队列'),
                vscode.TreeItemCollapsibleState.None,
                'empty',
                'pass'
            ));
            return rootItems;
        }

        return [
            ...rootItems,
            ...queues.map(queue => this.createQueueItem(queue))
        ];
    }

    private createActionItem(label: string, command: string, icon: string): CurrentWorkItem {
        const item = new CurrentWorkItem(label, vscode.TreeItemCollapsibleState.None, 'action', icon);
        item.command = { command, title: label };
        return item;
    }

    private createQueueItem(queue: AutoTaskQueueRecoveryRecord): CurrentWorkItem {
        const summary = getAutoTaskQueueSummary(queue.record);
        const item = new CurrentWorkItem(queue.specName, vscode.TreeItemCollapsibleState.Expanded, 'queue', getQueueStatusIcon(queue.record.status), queue);
        item.description = [
            formatQueueStatus(queue.record.status),
            `${summary.taskCount} ${localize('task(s)', '个任务')}`
        ].join(' - ');
        item.tooltip = [
            `${localize('Spec', '规格')}: ${queue.specName}`,
            `${localize('Status', '状态')}: ${formatQueueStatus(queue.record.status)}`,
            `${localize('Tasks', '任务数')}: ${summary.taskCount}`,
            queue.record.pauseReason ? `${localize('Pause reason', '暂停原因')}: ${queue.record.pauseReason}` : undefined,
            queue.record.lastEvent ? `${localize('Last event', '最近事件')}: ${queue.record.lastEvent}` : undefined
        ].filter(Boolean).join('\n');
        item.command = {
            command: 'autocode.spec.showTaskQueueDetails',
            title: localize('Show Queue Details', '查看队列详情'),
            arguments: [queue.documentUri]
        };
        return item;
    }

    private getQueueChildren(queue: AutoTaskQueueRecoveryRecord): CurrentWorkItem[] {
        const record = queue.record;
        const queuedTasks = getQueuedTasks(record);
        const items = [
            this.createDetailItem(`${localize('Status', '状态')}: ${formatQueueStatus(record.status)}`, getQueueStatusIcon(record.status)),
            this.createDetailItem(`${localize('Queued tasks', '队列任务')}: ${queuedTasks.length}`, 'list-tree'),
            record.batchTasks?.length ? this.createDetailItem(`${localize('Current batch', '当前批次')}: ${record.batchTasks.length}`, 'layers') : undefined,
            record.pauseReason ? this.createDetailItem(`${localize('Pause reason', '暂停原因')}: ${record.pauseReason}`, 'debug-pause') : undefined,
            record.lastEvent ? this.createDetailItem(`${localize('Last event', '最近事件')}: ${record.lastEvent}`, 'history') : undefined,
            this.createActionForQueue(localize('Resume Queue', '继续队列'), 'autocode.spec.resumeTaskQueue', 'debug-continue', queue),
            this.createActionForQueue(localize('Open Details', '打开详情'), 'autocode.spec.showTaskQueueDetails', 'inspect', queue),
            this.createActionForQueue(localize('Cancel Queue', '取消队列'), 'autocode.spec.cancelTaskQueue', 'debug-stop', queue)
        ].filter((item): item is CurrentWorkItem => Boolean(item));

        return [
            ...items,
            ...queuedTasks.map(task => this.createTaskItem(record.status, task))
        ];
    }

    private createActionForQueue(label: string, command: string, icon: string, queue: AutoTaskQueueRecoveryRecord): CurrentWorkItem {
        const item = new CurrentWorkItem(label, vscode.TreeItemCollapsibleState.None, 'action', icon);
        item.command = {
            command,
            title: label,
            arguments: [queue.documentUri]
        };
        return item;
    }

    private createDetailItem(label: string, icon: string | vscode.ThemeIcon): CurrentWorkItem {
        return new CurrentWorkItem(label, vscode.TreeItemCollapsibleState.None, 'queue-detail', icon);
    }

    private createTaskItem(status: string, task: AutoTaskQueueTaskState): CurrentWorkItem {
        const prefix = status === 'waiting_for_signal'
            ? localize('Waiting', '等待')
            : status === 'paused'
                ? localize('Pending/failed', '待处理/失败')
                : localize('Task', '任务');
        return this.createDetailItem(`${prefix} ${task.lineNumber + 1}: ${task.taskDescription}`, 'debug-stackframe-dot');
    }

    private async getQueues(): Promise<AutoTaskQueueRecoveryRecord[]> {
        try {
            const configManager = ConfigManager.getInstance();
            await configManager.loadSettings();
            return findRecoverableAutoTaskQueues(vscode.workspace.workspaceFolders, configManager.getPath('specs'));
        } catch (error) {
            this.outputChannel.appendLine(`[CurrentWork] Failed to inspect task queues: ${error}`);
            return [];
        }
    }
}

export class CurrentWorkItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly kind: CurrentWorkItemKind,
        icon: string | vscode.ThemeIcon,
        public readonly queue?: AutoTaskQueueRecoveryRecord
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.contextValue = `current-work-${kind}`;
        this.iconPath = typeof icon === 'string' ? new vscode.ThemeIcon(icon) : icon;
        this.tooltip = label;
    }
}

function getQueuedTasks(record: AutoTaskQueueRecoveryRecord['record']): AutoTaskQueueTaskState[] {
    return [
        ...(record.currentTask ? [record.currentTask] : []),
        ...(record.batchTasks ?? [])
    ];
}

function formatQueueStatus(status: string): string {
    return status.replace(/_/g, ' ');
}

function getQueueStatusIcon(status: string | undefined): vscode.ThemeIcon {
    if (status === 'paused') {
        return new vscode.ThemeIcon('debug-pause');
    }

    if (status === 'waiting_for_signal') {
        return new vscode.ThemeIcon('watch');
    }

    if (status === 'running') {
        return new vscode.ThemeIcon('debug-start');
    }

    return new vscode.ThemeIcon('list-tree');
}
