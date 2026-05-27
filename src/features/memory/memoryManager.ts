import * as vscode from 'vscode';
import * as path from 'path';
import { getRuntimeValue } from '../../runtime/runtimeSettings';

export type MemoryScope = 'project' | 'user' | 'spec' | 'task' | 'session';
export type MemoryType = 'fact' | 'decision' | 'preference' | 'pitfall' | 'command' | 'verification' | 'summary';
export type MemoryStatus = 'active' | 'superseded' | 'forgotten' | 'conflict';

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
    subject?: string;
    fingerprint?: string;
    conflictWith?: string[];
    metadata?: Record<string, unknown>;
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
    subject?: string;
    metadata?: Record<string, unknown>;
}

export interface MemorySearchRequest {
    query: string;
    specFilePath?: string;
    currentFilePath?: string;
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
    filesChanged?: string[];
    verifyCommands?: string[];
    followUps?: string[];
    pitfalls?: string[];
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
    summary?: string;
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

        const redaction = this.redactSensitiveText(request.text);
        const text = redaction.text.trim();
        if (!text) {
            return undefined;
        }

        const tags = this.normalizeTags([
            ...(request.tags ?? this.inferTags(text)),
            ...(redaction.redacted ? ['redacted-sensitive'] : [])
        ]);
        const subject = this.normalizeSubject(request.subject ?? this.inferSubject(text, tags, request.source));
        const fingerprint = this.fingerprintText(text);
        const record: MemoryRecord = {
            id: this.createId('mem'),
            scope: request.scope,
            type: request.type,
            text,
            source: request.source,
            tags,
            confidence: this.clampConfidence(request.confidence ?? 0.8),
            createdAt: new Date().toISOString(),
            status: 'active',
            subject,
            fingerprint,
            metadata: this.sanitizeMetadata(request.metadata)
        };

        const storagePath = this.getStoragePathForRecord(record, request.specFilePath);
        const records = await this.readRecordsFromPath(storagePath);
        for (const existing of records) {
            if (this.isDuplicateMemory(existing, record)) {
                return existing;
            }

            if (this.shouldSupersede(existing, record)) {
                existing.status = 'superseded';
                existing.supersededBy = record.id;
                existing.updatedAt = record.createdAt;
                continue;
            }

            if (this.isConflictingMemory(existing, record)) {
                existing.status = 'conflict';
                existing.conflictWith = this.addUnique(existing.conflictWith, record.id);
                existing.updatedAt = record.createdAt;
                record.status = 'conflict';
                record.conflictWith = this.addUnique(record.conflictWith, existing.id);
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
        const evidence = request.evidence ?? [];
        const metadata = {
            taskId: this.parseTaskId(request.taskDescription),
            specName: this.getSpecNameFromTaskFilePath(request.taskFilePath),
            outcome: request.verified ? 'verified' : 'not-verified',
            lineNumber: request.lineNumber,
            filesChanged: request.filesChanged ?? [],
            verifyCommands: request.verifyCommands ?? this.extractVerifyCommands([request.summary, ...evidence].filter((item): item is string => Boolean(item))),
            evidence,
            followUps: request.followUps ?? this.extractFollowUps(request.summary),
            pitfalls: request.pitfalls ?? this.extractPitfalls([request.summary, ...evidence].filter((item): item is string => Boolean(item)))
        };

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
            confidence: request.verified ? 0.95 : 0.65,
            metadata
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
            confidence: 0.85,
            metadata: {
                taskId: this.parseTaskId(request.taskDescription),
                specName: this.getSpecNameFromTaskFilePath(request.taskFilePath),
                lineNumber: request.lineNumber,
                sessionId: request.sessionId,
                invocationId: request.invocationId,
                providerName: request.providerName,
                providerSessionId: request.providerSessionId,
                promptSnapshotPath: request.promptSnapshotPath,
                summary: request.summary
            }
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
        const maxPromptChars = Math.max(1000, getRuntimeValue<number>('memory.maxPromptChars', 12000));
        let usedChars = sections.join('\n').length;
        let omittedCount = 0;

        for (const [key, items] of groups) {
            const header = ['', `### ${this.formatGroupTitle(key)}`];
            const headerLength = header.join('\n').length + 1;
            if (usedChars + headerLength > maxPromptChars) {
                omittedCount += items.length;
                continue;
            }

            sections.push(...header);
            usedChars += headerLength;
            for (const item of items) {
                const tags = item.tags?.length ? ` [${item.tags.slice(0, 4).join(', ')}]` : '';
                const line = `- ${this.formatMemoryTextForPrompt(item.text, Math.min(1200, Math.max(240, maxPromptChars - usedChars - tags.length - 4)))}${tags}`;
                if (usedChars + line.length + 1 > maxPromptChars) {
                    omittedCount += 1;
                    continue;
                }

                sections.push(line);
                usedChars += line.length + 1;
            }
        }

        if (omittedCount > 0) {
            const footer = `\n(${omittedCount} lower-priority memory item(s) omitted because of prompt budget.)`;
            const output = sections.join('\n');
            if (output.length + footer.length <= maxPromptChars) {
                return `${output}${footer}`;
            }

            const clippedMarker = '\n... [memory truncated]';
            const clippedLength = Math.max(0, maxPromptChars - footer.length - clippedMarker.length - 1);
            return `${output.slice(0, clippedLength).trimEnd()}${clippedMarker}${footer}`;
        }

        return sections.join('\n');
    }

    async search(request: MemorySearchRequest): Promise<StoredMemoryRecord[]> {
        const maxItems = request.maxItems ?? getRuntimeValue<number>('memory.maxPromptItems', 8);
        const records = await this.readSearchCorpus(request);
        const queryTokens = this.tokenize(request.query);
        const scored = records
            .filter(record => this.isRetrievableStatus(record.status))
            .map(record => ({
                record,
                score: this.scoreRecord(record, queryTokens, request)
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt));

        return scored.slice(0, Math.max(1, maxItems)).map(item => item.record);
    }

    async listRecords(category?: string): Promise<StoredMemoryRecord[]> {
        const records = await this.readSearchCorpus({
            includeUserPreferences: true
        });
        const activeRecords = records.filter(record => this.isRetrievableStatus(record.status));

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
        if (!this.isRetrievableStatus(existing.status)) {
            return false;
        }

        if (!this.isSameMemorySubject(existing, next)) {
            return false;
        }

        if (this.normalizeText(existing.text) === this.normalizeText(next.text) || this.isConflictingMemory(existing, next)) {
            return false;
        }

        return this.isSameSource(existing.source, next.source) ||
            (this.textSimilarity(existing.text, next.text) >= 0.75 && next.confidence >= existing.confidence);
    }

    private isDuplicateMemory(existing: MemoryRecord, next: MemoryRecord): boolean {
        if (!this.isRetrievableStatus(existing.status)) {
            return false;
        }

        return existing.scope === next.scope &&
            existing.type === next.type &&
            this.getFingerprint(existing) === this.getFingerprint(next);
    }

    private isConflictingMemory(existing: MemoryRecord, next: MemoryRecord): boolean {
        if (!this.isSameMemorySubject(existing, next)) {
            return false;
        }

        if (this.normalizeText(existing.text) === this.normalizeText(next.text)) {
            return false;
        }

        const conflictTypes: MemoryType[] = ['fact', 'decision', 'preference', 'command'];
        if (!conflictTypes.includes(existing.type) && !conflictTypes.includes(next.type)) {
            return false;
        }

        return this.hasOpposingLanguage(existing.text, next.text);
    }

    private isSameMemorySubject(existing: MemoryRecord, next: MemoryRecord): boolean {
        return existing.scope === next.scope &&
            existing.type === next.type &&
            this.getSubject(existing) === this.getSubject(next);
    }

    private isRetrievableStatus(status: MemoryStatus | undefined): boolean {
        return (status ?? 'active') === 'active' || status === 'conflict';
    }

    private isSameSource(left?: MemorySource, right?: MemorySource): boolean {
        if (!left || !right) {
            return false;
        }

        return left.kind === right.kind &&
            this.normalizePathForMemory(left.path ?? '') === this.normalizePathForMemory(right.path ?? '') &&
            left.lineNumber === right.lineNumber &&
            left.sessionId === right.sessionId;
    }

    private inferSubject(text: string, tags: readonly string[], source?: MemorySource): string {
        if (source?.path) {
            return `${source.kind}:${this.normalizePathForMemory(source.path)}${source.lineNumber !== undefined ? `:${source.lineNumber}` : ''}`;
        }

        return tags.slice(0, 3).join('|') || this.tokenize(text).filter(token => token.length >= 3).slice(0, 5).join('|') || 'general';
    }

    private normalizeSubject(subject: string): string {
        return subject.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private getSubject(record: MemoryRecord): string {
        return this.normalizeSubject(record.subject ?? this.inferSubject(record.text, record.tags ?? [], record.source));
    }

    private getFingerprint(record: MemoryRecord): string {
        return record.fingerprint ?? this.fingerprintText(record.text);
    }

    private fingerprintText(text: string): string {
        return this.hashString(this.normalizeText(text));
    }

    private textSimilarity(leftText: string, rightText: string): number {
        const left = new Set(this.tokenize(leftText));
        const right = new Set(this.tokenize(rightText));
        if (left.size === 0 || right.size === 0) {
            return 0;
        }

        let intersection = 0;
        for (const token of left) {
            if (right.has(token)) {
                intersection += 1;
            }
        }

        const union = new Set([...left, ...right]).size;
        return union === 0 ? 0 : intersection / union;
    }

    private hasOpposingLanguage(leftText: string, rightText: string): boolean {
        const left = this.normalizeText(leftText);
        const right = this.normalizeText(rightText);
        const leftNegative = this.hasNegativeMarker(left);
        const rightNegative = this.hasNegativeMarker(right);
        if (leftNegative !== rightNegative && this.textSimilarity(left, right) >= 0.25) {
            return true;
        }

        const opposingPairs: Array<[RegExp, RegExp]> = [
            [/\b(enable|enabled|use|allow|should|must|prefer|true|on|yes)\b/i, /\b(disable|disabled|avoid|forbid|never|do not|don't|skip|false|off|no)\b/i],
            [/\b(开启|启用|使用|允许|必须|应该|优先)\b/u, /\b(关闭|禁用|避免|禁止|不要|跳过)\b/u]
        ];

        return opposingPairs.some(([positive, negative]) =>
            (positive.test(left) && negative.test(right)) ||
            (negative.test(left) && positive.test(right))
        );
    }

    private hasNegativeMarker(text: string): boolean {
        return /\b(disable|disabled|avoid|forbid|never|do not|don't|skip|false|off|no)\b|关闭|禁用|避免|禁止|不要|跳过/u.test(text);
    }

    private addUnique(values: string[] | undefined, value: string): string[] {
        return [...new Set([...(values ?? []), value])];
    }

    private normalizePathForMemory(filePath: string): string {
        return filePath.replace(/\\/g, '/').toLowerCase();
    }

    private scoreRecord(record: StoredMemoryRecord | MemoryRecord, queryTokens: string[], request: MemorySearchRequest): number {
        const rawQuery = request.query;
        if (queryTokens.length === 0) {
            return this.getContextScore(record, request);
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

        score += this.getTypeWeight(record);
        score += this.getContextScore(record, request);
        score += this.getRecencyScore(record);
        score += Math.max(0, Math.min(1, record.confidence)) * 2;

        if (record.scope === 'user' && /偏好|preference|language|中文|确认|confirm/i.test(rawQuery)) {
            score += 3;
        }

        if (record.type === 'pitfall' && /失败|错误|bug|blocked|fail|error/i.test(rawQuery)) {
            score += 4;
        }

        if (record.type === 'verification' && /task|任务|验证|完成/i.test(rawQuery)) {
            score += 1;
        }

        if (record.scope === 'session') {
            score -= 1.5;
        }

        return score;
    }

    private getTypeWeight(record: MemoryRecord): number {
        if (record.type === 'preference') {
            return 3;
        }
        if (record.type === 'pitfall') {
            return 2.5;
        }
        if (record.type === 'decision') {
            return 2;
        }
        if (record.type === 'command') {
            return 1.5;
        }
        if (record.type === 'verification') {
            return 1;
        }
        if (record.type === 'summary') {
            return -0.5;
        }
        return 0.5;
    }

    private getContextScore(record: StoredMemoryRecord | MemoryRecord, request: MemorySearchRequest): number {
        let score = 0;
        const specFilePath = request.specFilePath ? this.normalizePathForMemory(request.specFilePath) : undefined;
        const currentFilePath = request.currentFilePath ? this.normalizePathForMemory(request.currentFilePath) : undefined;
        const sourcePath = record.source?.path ? this.normalizePathForMemory(record.source.path) : undefined;
        const storagePath = 'storagePath' in record ? this.normalizePathForMemory(record.storagePath) : undefined;

        if (specFilePath) {
            const specDir = this.normalizePathForMemory(path.dirname(specFilePath));
            if (sourcePath?.startsWith(specDir) || storagePath?.startsWith(`${specDir}/memory/`)) {
                score += 5;
            }
        }

        if (currentFilePath && sourcePath) {
            if (sourcePath === currentFilePath) {
                score += 4;
            } else if (this.normalizePathForMemory(path.dirname(sourcePath)) === this.normalizePathForMemory(path.dirname(currentFilePath))) {
                score += 2;
            }
        }

        if (record.scope === 'user') {
            score += 1;
        }

        return score;
    }

    private getRecencyScore(record: MemoryRecord): number {
        const createdAt = Date.parse(record.updatedAt ?? record.createdAt);
        if (!Number.isFinite(createdAt)) {
            return 0;
        }

        const ageDays = Math.max(0, (Date.now() - createdAt) / (24 * 60 * 60 * 1000));
        if (ageDays <= 7) {
            return 2;
        }
        if (ageDays <= 30) {
            return 1;
        }
        if (ageDays <= 180) {
            return 0;
        }
        return -1;
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

    private parseTaskId(description: string): string | undefined {
        return description.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+/)?.[1];
    }

    private getSpecNameFromTaskFilePath(taskFilePath: string): string | undefined {
        const normalized = taskFilePath.replace(/\\/g, '/');
        const match = normalized.match(/\/\.autocode\/specs\/([^/]+)\/tasks\.md$/);
        return match?.[1];
    }

    private extractVerifyCommands(values: readonly string[]): string[] {
        const commands = new Set<string>();
        const commandPattern = /\b(?:npm|pnpm|yarn|npx|node|dotnet|go|cargo|python|python3|pytest|vitest|jest|tsc|webpack|vsce|mvn|gradle|make|cmake)\b[^\r\n]*/gi;
        for (const value of values) {
            for (const match of value.match(commandPattern) ?? []) {
                commands.add(match.trim().replace(/[.;。]+$/g, ''));
            }
        }

        return [...commands].slice(0, 12);
    }

    private extractFollowUps(summary: string | undefined): string[] {
        if (!summary) {
            return [];
        }

        return summary
            .split(/\r?\n|[.;。]/)
            .map(line => line.trim())
            .filter(line => /\b(todo|follow.?up|next|later|remaining)\b|后续|待办|下一步|剩余/i.test(line))
            .slice(0, 8);
    }

    private extractPitfalls(values: readonly string[]): string[] {
        return values
            .flatMap(value => value.split(/\r?\n|[.;。]/))
            .map(line => line.trim())
            .filter(line => /\b(fail|failed|error|blocked|flaky|pitfall|risk|cannot|unable)\b|失败|错误|阻塞|风险|无法/i.test(line))
            .slice(0, 8);
    }

    private redactSensitiveText(value: string): { text: string; redacted: boolean } {
        const replacements: Array<[RegExp, string | ((match: string) => string)]> = [
            [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[REDACTED]'],
            [/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, 'gh_[REDACTED]'],
            [/\bAKIA[0-9A-Z]{12,}\b/g, 'AKIA[REDACTED]'],
            [/\b(?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, match => `${match.split(/[:=]/)[0].trim()}=[REDACTED]`],
            [/\bC:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[REDACTED]'],
            [/\/home\/[^/\s]+/g, '/home/[REDACTED]'],
            [/\/Users\/[^/\s]+/g, '/Users/[REDACTED]']
        ];

        let text = value;
        for (const [pattern, replacement] of replacements) {
            text = text.replace(pattern, replacement as string);
        }

        return {
            text,
            redacted: text !== value
        };
    }

    private sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }

        return this.sanitizeMetadataValue(value) as Record<string, unknown>;
    }

    private sanitizeMetadataValue(value: unknown): unknown {
        if (typeof value === 'string') {
            return this.redactSensitiveText(value).text;
        }
        if (Array.isArray(value)) {
            return value.map(item => this.sanitizeMetadataValue(item));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.sanitizeMetadataValue(item)]));
        }
        return value;
    }

    private normalizeTags(tags: string[]): string[] {
        return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
    }

    private normalizeText(text: string): string {
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private formatMemoryTextForPrompt(text: string, maxChars: number): string {
        const compact = text.replace(/\s+/g, ' ').trim();
        if (compact.length <= maxChars) {
            return compact;
        }

        const headLength = Math.max(80, maxChars - 48);
        return `${compact.slice(0, headLength).trimEnd()}... [memory truncated]`;
    }

    private hashString(value: string): string {
        let hash = 0;
        for (let index = 0; index < value.length; index++) {
            hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
        }

        return (hash >>> 0).toString(36);
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
