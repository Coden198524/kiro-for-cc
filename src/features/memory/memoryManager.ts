import * as vscode from 'vscode';
import * as path from 'path';
import { getRuntimeValue } from '../../runtime/runtimeSettings';

export type MemoryScope = 'project' | 'user' | 'spec' | 'task' | 'session';
export type MemoryType = 'fact' | 'decision' | 'preference' | 'pitfall' | 'command' | 'verification' | 'summary';
export type MemoryStatus = 'active' | 'superseded' | 'forgotten';

export interface MemorySource {
    kind: 'task' | 'user' | 'file' | 'verification' | 'session' | 'spec';
    path?: string;
    sessionId?: string;
    lineNumber?: number;
}

export interface MemoryRecord {
    id: string;
    scope: MemoryScope;
    type: MemoryType;
    text: string;
    source?: MemorySource;
    tags?: string[];
    confidence: number;
    createdAt: string;
    updatedAt?: string;
    status?: MemoryStatus;
    supersededBy?: string;
}

export interface StoredMemoryRecord extends MemoryRecord {
    storagePath: string;
}

export interface AddMemoryRequest {
    scope: MemoryScope;
    type: MemoryType;
    text: string;
    source?: MemorySource;
    tags?: string[];
    confidence?: number;
    specFilePath?: string;
}

export interface MemorySearchRequest {
    query: string;
    specFilePath?: string;
    includeUserPreferences?: boolean;
    maxItems?: number;
}

export interface TaskMemoryRequest {
    taskFilePath: string;
    lineNumber: number;
    taskDescription: string;
    verified: boolean;
    summary?: string;
    evidence?: string[];
}

export interface SessionMemoryRequest {
    taskFilePath: string;
    taskDescription: string;
    lineNumber: number;
    sessionId: string;
    invocationId: string;
    providerName: string;
    providerSessionId?: string;
    promptSnapshotPath?: string;
}

export class MemoryManager {
    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel
    ) { }

    isEnabled(): boolean {
        return getRuntimeValue<boolean>('memory.enabled', true);
    }

    isAutoWriteEnabled(): boolean {
        return this.isEnabled() && getRuntimeValue<boolean>('memory.autoWrite', true);
    }

    async addMemory(request: AddMemoryRequest): Promise<MemoryRecord | undefined> {
        if (!this.isEnabled()) {
            return undefined;
        }

        const text = request.text.trim();
        if (!text) {
            return undefined;
        }

        const record: MemoryRecord = {
            id: this.createId('mem'),
            scope: request.scope,
            type: request.type,
            text,
            source: request.source,
            tags: this.normalizeTags(request.tags ?? this.inferTags(text)),
            confidence: this.clampConfidence(request.confidence ?? 0.8),
            createdAt: new Date().toISOString(),
            status: 'active'
        };

        const storagePath = this.getStoragePathForRecord(record, request.specFilePath);
        const records = await this.readRecordsFromPath(storagePath);
        for (const existing of records) {
            if (this.shouldSupersede(existing, record)) {
                existing.status = 'superseded';
                existing.supersededBy = record.id;
                existing.updatedAt = record.createdAt;
            }
        }

        records.push(record);
        await this.writeRecordsToPath(storagePath, records);
        await this.appendMarkdownMirror(record, request.specFilePath);
        return record;
    }

    async recordTaskCompletion(request: TaskMemoryRequest): Promise<void> {
        if (!this.isAutoWriteEnabled()) {
            return;
        }

        const summaryParts = [
            request.verified ? 'Task verified and completed.' : 'Task completion was not verified.',
            request.taskDescription,
            request.summary
        ].filter(Boolean);

        await this.addMemory({
            scope: 'task',
            type: 'verification',
            text: summaryParts.join(' '),
            specFilePath: request.taskFilePath,
            source: {
                kind: 'verification',
                path: request.taskFilePath,
                lineNumber: request.lineNumber
            },
            tags: [
                'task-completion',
                request.verified ? 'verified' : 'not-verified',
                ...this.inferTags(request.taskDescription)
            ],
            confidence: request.verified ? 0.95 : 0.65
        });
    }

    async recordSessionInvocation(request: SessionMemoryRequest): Promise<void> {
        if (!this.isAutoWriteEnabled()) {
            return;
        }

        await this.addMemory({
            scope: 'session',
            type: 'summary',
            text: [
                `${request.providerName} session started for task: ${request.taskDescription}.`,
                request.providerSessionId ? `Provider session: ${request.providerSessionId}.` : '',
                request.promptSnapshotPath ? `Prompt snapshot: ${request.promptSnapshotPath}.` : ''
            ].filter(Boolean).join(' '),
            source: {
                kind: 'session',
                path: request.taskFilePath,
                sessionId: request.sessionId,
                lineNumber: request.lineNumber
            },
            tags: ['session', request.providerName, ...this.inferTags(request.taskDescription)],
            confidence: 0.85
        });
    }

    async buildPromptContext(request: MemorySearchRequest): Promise<string> {
        if (!this.isEnabled()) {
            return 'AutoCode memory is disabled.';
        }

        const records = await this.search(request);
        if (records.length === 0) {
            return 'No relevant AutoCode memory was found.';
        }

        const groups = new Map<string, StoredMemoryRecord[]>();
        for (const record of records) {
            const key = `${record.scope}:${record.type}`;
            groups.set(key, [...(groups.get(key) ?? []), record]);
        }

        const sections: string[] = [
            'Use these memories as guidance, not as absolute truth.',
            'Priority order: current user request > current spec documents > project memory > user preferences > older session memory.',
            'If a memory conflicts with current files or user instructions, follow the current source and mention the conflict briefly.'
        ];

        for (const [key, items] of groups) {
            sections.push('', `### ${this.formatGroupTitle(key)}`);
            for (const item of items) {
                const tags = item.tags?.length ? ` [${item.tags.slice(0, 4).join(', ')}]` : '';
                sections.push(`- ${item.text}${tags}`);
            }
        }

        return sections.join('\n');
    }

    async search(request: MemorySearchRequest): Promise<StoredMemoryRecord[]> {
        const maxItems = request.maxItems ?? getRuntimeValue<number>('memory.maxPromptItems', 8);
        const records = await this.readSearchCorpus(request);
        const queryTokens = this.tokenize(request.query);
        const scored = records
            .filter(record => (record.status ?? 'active') === 'active')
            .map(record => ({
                record,
                score: this.scoreRecord(record, queryTokens, request.query)
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt));

        return scored.slice(0, Math.max(1, maxItems)).map(item => item.record);
    }

    async listRecords(category?: string): Promise<StoredMemoryRecord[]> {
        const records = await this.readSearchCorpus({
            includeUserPreferences: true
        });
        const activeRecords = records.filter(record => (record.status ?? 'active') === 'active');

        if (!category) {
            return activeRecords;
        }

        return activeRecords.filter(record => {
            if (category === 'project') {
                return record.scope === 'project';
            }
            if (category === 'user') {
                return record.scope === 'user';
            }
            if (category === 'spec') {
                return record.scope === 'spec' || record.scope === 'task';
            }
            if (category === 'session') {
                return record.scope === 'session';
            }
            if (category === 'pitfall') {
                return record.type === 'pitfall';
            }
            return true;
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async forgetMemory(record: MemoryRecord): Promise<boolean> {
        const stored = 'storagePath' in record
            ? record as StoredMemoryRecord
            : (await this.listRecords()).find(item => item.id === record.id);
        if (!stored) {
            return false;
        }

        const records = await this.readRecordsFromPath(stored.storagePath);
        const target = records.find(item => item.id === stored.id);
        if (!target) {
            return false;
        }

        target.status = 'forgotten';
        target.updatedAt = new Date().toISOString();
        await this.writeRecordsToPath(stored.storagePath, records);
        return true;
    }

    async openMemorySource(record: MemoryRecord): Promise<void> {
        const sourcePath = record.source?.path;
        if (!sourcePath) {
            vscode.window.showInformationMessage('This memory has no source file.');
            return;
        }

        const document = await vscode.workspace.openTextDocument(sourcePath);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    async openProjectMemoryFile(fileName = 'facts.jsonl'): Promise<void> {
        const filePath = path.join(this.getProjectMemoryDir(), fileName);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
        await this.ensureFileExists(filePath);
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    getMemoryRootPath(): string {
        return path.join(this.getWorkspaceRoot(), '.autocode', 'memory');
    }

    private async readSearchCorpus(request: Pick<MemorySearchRequest, 'specFilePath' | 'includeUserPreferences'>): Promise<StoredMemoryRecord[]> {
        const paths = new Set<string>();
        paths.add(path.join(this.getProjectMemoryDir(), 'facts.jsonl'));
        paths.add(path.join(this.getProjectMemoryDir(), 'pitfalls.jsonl'));
        paths.add(path.join(this.getProjectMemoryDir(), 'decisions.jsonl'));
        paths.add(path.join(this.getMemoryRootPath(), 'sessions', 'sessions.jsonl'));

        if (request.includeUserPreferences !== false) {
            paths.add(this.getUserMemoryPath());
        }

        if (request.specFilePath) {
            paths.add(path.join(this.getSpecMemoryDir(request.specFilePath), 'task-history.jsonl'));
            paths.add(path.join(this.getSpecMemoryDir(request.specFilePath), 'verification.jsonl'));
        } else {
            for (const specMemoryPath of await this.listSpecMemoryJsonlPaths()) {
                paths.add(specMemoryPath);
            }
        }

        const records: StoredMemoryRecord[] = [];
        for (const filePath of paths) {
            for (const record of await this.readRecordsFromPath(filePath)) {
                records.push({ ...record, storagePath: filePath });
            }
        }

        return records;
    }

    private async listSpecMemoryJsonlPaths(): Promise<string[]> {
        const specsDir = path.join(this.getWorkspaceRoot(), '.autocode', 'specs');
        const results: string[] = [];
        try {
            const specs = await vscode.workspace.fs.readDirectory(vscode.Uri.file(specsDir));
            for (const [name, type] of specs) {
                if (type !== vscode.FileType.Directory) {
                    continue;
                }
                const memoryDir = path.join(specsDir, name, 'memory');
                try {
                    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(memoryDir));
                    for (const [entryName, entryType] of entries) {
                        if (entryType === vscode.FileType.File && entryName.endsWith('.jsonl')) {
                            results.push(path.join(memoryDir, entryName));
                        }
                    }
                } catch {
                    // Spec memory is optional.
                }
            }
        } catch {
            // Specs directory may not exist yet.
        }

        return results;
    }

    private getStoragePathForRecord(record: MemoryRecord, specFilePath?: string): string {
        if (record.scope === 'user') {
            return this.getUserMemoryPath();
        }

        if (record.scope === 'session') {
            return path.join(this.getMemoryRootPath(), 'sessions', 'sessions.jsonl');
        }

        if (record.scope === 'task' || record.scope === 'spec') {
            const specPath = specFilePath ?? record.source?.path;
            if (specPath) {
                return path.join(
                    this.getSpecMemoryDir(specPath),
                    record.type === 'verification' ? 'verification.jsonl' : 'task-history.jsonl'
                );
            }
        }

        if (record.type === 'pitfall') {
            return path.join(this.getProjectMemoryDir(), 'pitfalls.jsonl');
        }

        if (record.type === 'decision') {
            return path.join(this.getProjectMemoryDir(), 'decisions.jsonl');
        }

        return path.join(this.getProjectMemoryDir(), 'facts.jsonl');
    }

    private async appendMarkdownMirror(record: MemoryRecord, specFilePath?: string): Promise<void> {
        if (record.scope === 'user' || record.scope === 'session' || record.scope === 'task') {
            return;
        }

        const fileName = record.type === 'pitfall'
            ? 'pitfalls.md'
            : record.type === 'decision'
                ? 'decisions.md'
                : undefined;
        if (!fileName) {
            return;
        }

        const filePath = specFilePath
            ? path.join(this.getSpecMemoryDir(specFilePath), fileName)
            : path.join(this.getProjectMemoryDir(), fileName);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
        const existing = await this.readTextIfExists(filePath) ?? '';
        const entry = [
            `## ${record.createdAt}`,
            '',
            record.text,
            record.tags?.length ? `\nTags: ${record.tags.join(', ')}` : ''
        ].join('\n');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from([existing.trim(), entry].filter(Boolean).join('\n\n')));
    }

    private async readRecordsFromPath(filePath: string): Promise<MemoryRecord[]> {
        const text = await this.readTextIfExists(filePath);
        if (!text) {
            return [];
        }

        const records: MemoryRecord[] = [];
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) {
                continue;
            }

            try {
                const parsed = JSON.parse(line) as MemoryRecord;
                if (parsed.id && parsed.text && parsed.scope && parsed.type) {
                    records.push(parsed);
                }
            } catch (error) {
                this.outputChannel.appendLine(`[Memory] Failed to parse memory record in ${filePath}: ${error}`);
            }
        }

        return records;
    }

    private async writeRecordsToPath(filePath: string, records: MemoryRecord[]): Promise<void> {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
        const content = records.map(record => JSON.stringify(record)).join('\n');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content ? `${content}\n` : ''));
    }

    private async ensureFileExists(filePath: string): Promise<void> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        } catch {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(''));
        }
    }

    private async readTextIfExists(filePath: string): Promise<string | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            return Buffer.from(content).toString().replace(/^\uFEFF/, '');
        } catch {
            return undefined;
        }
    }

    private shouldSupersede(existing: MemoryRecord, next: MemoryRecord): boolean {
        if ((existing.status ?? 'active') !== 'active') {
            return false;
        }

        if (existing.scope !== next.scope || existing.type !== next.type) {
            return false;
        }

        const sharedTags = (existing.tags ?? []).some(tag => (next.tags ?? []).includes(tag));
        return sharedTags && this.normalizeText(existing.text) !== this.normalizeText(next.text);
    }

    private scoreRecord(record: MemoryRecord, queryTokens: string[], rawQuery: string): number {
        if (queryTokens.length === 0) {
            return 1;
        }

        const haystack = [
            record.text,
            ...(record.tags ?? []),
            record.source?.path ?? ''
        ].join(' ').toLowerCase();
        let score = 0;
        for (const token of queryTokens) {
            if (haystack.includes(token)) {
                score += token.length >= 3 ? 2 : 1;
            }
        }

        if (record.scope === 'user' && /偏好|preference|language|中文|确认|confirm/i.test(rawQuery)) {
            score += 1;
        }

        if (record.type === 'pitfall' && /失败|错误|bug|blocked|fail|error/i.test(rawQuery)) {
            score += 2;
        }

        if (record.type === 'verification' && /task|任务|验证|完成/i.test(rawQuery)) {
            score += 1;
        }

        return score;
    }

    private tokenize(text: string): string[] {
        const normalized = text.toLowerCase();
        const tokens = new Set<string>();
        for (const match of normalized.match(/[a-z0-9_./-]{2,}|[\u3400-\u9fff]{2,}/g) ?? []) {
            tokens.add(match);
        }

        for (const char of normalized.match(/[\u3400-\u9fff]/g) ?? []) {
            tokens.add(char);
        }

        return [...tokens];
    }

    private inferTags(text: string): string[] {
        return this.tokenize(text)
            .filter(token => token.length >= 3 || /[\u3400-\u9fff]/.test(token))
            .slice(0, 8);
    }

    private normalizeTags(tags: string[]): string[] {
        return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
    }

    private normalizeText(text: string): string {
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private clampConfidence(value: number): number {
        return Math.max(0, Math.min(1, value));
    }

    private formatGroupTitle(key: string): string {
        const [scope, type] = key.split(':');
        return `${scope.charAt(0).toUpperCase()}${scope.slice(1)} ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    }

    private getProjectMemoryDir(): string {
        return path.join(this.getMemoryRootPath(), 'project');
    }

    private getSpecMemoryDir(specFilePath: string): string {
        return path.join(path.dirname(specFilePath), 'memory');
    }

    private getUserMemoryPath(): string {
        return path.join(this.getGlobalStorageRoot(), 'memory', 'user', 'preferences.jsonl');
    }

    private getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

    private getGlobalStorageRoot(): string {
        const context = this.context as vscode.ExtensionContext & { globalStoragePath?: string };
        return context.globalStorageUri?.fsPath ??
            context.globalStoragePath ??
            path.join(process.env.APPDATA || process.env.HOME || this.getWorkspaceRoot(), 'AutoCode');
    }

    private createId(prefix: string): string {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}
