import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProviderId } from '../../runtime/agentRuntime';

interface Logger {
    appendLine(message: string): void;
}

interface SearchTerm {
    label: string;
    normalized: string;
    weight: number;
    minLength: number;
}

interface HistoryFile {
    filePath: string;
    updatedAt: number;
}

export interface ProviderSessionHistorySearchRequest {
    providerId: AgentProviderId;
    taskFilePath: string;
    taskDescription: string;
    promptSnapshotPath?: string;
}

export interface ProviderSessionHistoryMatch {
    sessionId: string;
    filePath: string;
    score: number;
    matchedBy: string[];
    updatedAt: number;
}

export interface ProviderSessionHistoryOptions {
    homeDir?: string;
    maxFiles?: number;
    outputChannel?: Logger;
}

export class ProviderSessionHistory {
    private static readonly DEFAULT_MAX_FILES = 2500;
    private static readonly MIN_MATCH_SCORE = 90;
    private static readonly UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    constructor(private options: ProviderSessionHistoryOptions = {}) { }

    async findSession(request: ProviderSessionHistorySearchRequest): Promise<ProviderSessionHistoryMatch | undefined> {
        if (request.providerId !== 'codex' && request.providerId !== 'claude') {
            return undefined;
        }

        const root = this.getHistoryRoot(request.providerId);
        if (!root) {
            return undefined;
        }

        const terms = await this.buildSearchTerms(request);
        if (terms.length === 0) {
            return undefined;
        }

        const files = await this.collectHistoryFiles(root, request.providerId);
        let best: ProviderSessionHistoryMatch | undefined;
        for (const file of files) {
            const candidate = await this.scoreHistoryFile(request.providerId, file, terms);
            if (!candidate) {
                continue;
            }

            if (
                !best ||
                candidate.score > best.score ||
                (candidate.score === best.score && candidate.updatedAt > best.updatedAt)
            ) {
                best = candidate;
            }
        }

        return best;
    }

    private getHistoryRoot(providerId: AgentProviderId): string | undefined {
        const homeDir = this.options.homeDir ?? os.homedir();
        if (!homeDir) {
            return undefined;
        }

        if (providerId === 'codex') {
            return path.join(homeDir, '.codex', 'sessions');
        }

        if (providerId === 'claude') {
            return path.join(homeDir, '.claude', 'projects');
        }

        return undefined;
    }

    private async buildSearchTerms(request: ProviderSessionHistorySearchRequest): Promise<SearchTerm[]> {
        const terms: SearchTerm[] = [];
        const promptSnapshot = request.promptSnapshotPath
            ? await this.readTextFile(request.promptSnapshotPath)
            : undefined;

        this.addTerm(terms, 'task description', request.taskDescription, 100, 5);
        this.addTerm(terms, 'task title', this.stripTaskNumbering(request.taskDescription), 60, 8);
        this.addTerm(terms, 'task file path', request.taskFilePath, 50, 10);

        if (promptSnapshot) {
            this.addTerm(
                terms,
                'implementation prompt marker',
                'I just completed a spec workflow and now need to implement one of the specific tasks.',
                90,
                20
            );
            this.addTerm(
                terms,
                'batch implementation prompt marker',
                'Implement all remaining tasks from this spec task file in one continuous coding session.',
                90,
                20
            );
            this.addTerm(terms, 'completion signal path', this.extractCompletionSignalPath(promptSnapshot), 150, 12);
            this.addTerm(terms, 'run id', this.extractRunId(promptSnapshot), 120, 6);
            this.addTerm(terms, 'task mode', this.extractTaskMode(promptSnapshot), 25, 8);
        }

        return terms;
    }

    private addTerm(terms: SearchTerm[], label: string, value: string | undefined, weight: number, minLength: number): void {
        const normalized = this.normalize(value ?? '');
        if (normalized.length < minLength || terms.some(term => term.normalized === normalized)) {
            return;
        }

        terms.push({ label, normalized, weight, minLength });
    }

    private async collectHistoryFiles(root: string, providerId: AgentProviderId): Promise<HistoryFile[]> {
        const files: HistoryFile[] = [];
        await this.walkHistoryRoot(root, providerId, files);
        return files
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, this.options.maxFiles ?? ProviderSessionHistory.DEFAULT_MAX_FILES);
    }

    private async walkHistoryRoot(root: string, providerId: AgentProviderId, files: HistoryFile[]): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(root, entry.name);
            if (entry.isDirectory()) {
                if (this.shouldSkipDirectory(entry.name, providerId)) {
                    continue;
                }
                await this.walkHistoryRoot(fullPath, providerId, files);
                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }

            try {
                const stat = await fs.promises.stat(fullPath);
                files.push({ filePath: fullPath, updatedAt: stat.mtimeMs });
            } catch {
                this.options.outputChannel?.appendLine(`[ProviderSessionHistory] Failed to stat ${fullPath}`);
            }
        }
    }

    private shouldSkipDirectory(directoryName: string, providerId: AgentProviderId): boolean {
        if (directoryName === 'node_modules' || directoryName === '.git') {
            return true;
        }

        return providerId === 'claude' && directoryName === 'subagents';
    }

    private async scoreHistoryFile(
        providerId: AgentProviderId,
        file: HistoryFile,
        terms: SearchTerm[]
    ): Promise<ProviderSessionHistoryMatch | undefined> {
        const rawContent = await this.readTextFile(file.filePath);
        if (!rawContent) {
            return undefined;
        }

        const sessionId = this.extractSessionId(providerId, file.filePath, rawContent);
        if (!sessionId) {
            return undefined;
        }

        const normalizedContent = this.normalize(rawContent);
        let score = 0;
        const matchedBy: string[] = [];
        for (const term of terms) {
            if (normalizedContent.includes(term.normalized)) {
                score += term.weight;
                matchedBy.push(term.label);
            }
        }

        if (this.isVerificationSession(normalizedContent)) {
            score -= 160;
            matchedBy.push('verification session penalty');
        }

        if (score < ProviderSessionHistory.MIN_MATCH_SCORE) {
            return undefined;
        }

        return {
            sessionId,
            filePath: file.filePath,
            score,
            matchedBy,
            updatedAt: file.updatedAt
        };
    }

    private extractSessionId(providerId: AgentProviderId, filePath: string, rawContent: string): string | undefined {
        if (providerId === 'claude') {
            return this.extractUuid(path.basename(filePath, '.jsonl')) ??
                this.extractSessionIdFromContent(rawContent);
        }

        return this.extractCodexSessionId(rawContent) ??
            this.extractUuid(path.basename(filePath, '.jsonl'));
    }

    private extractCodexSessionId(rawContent: string): string | undefined {
        const firstLine = rawContent.split(/\r?\n/, 1)[0];
        try {
            const parsed = JSON.parse(firstLine) as { type?: string; payload?: { id?: unknown } };
            if (parsed.type === 'session_meta' && typeof parsed.payload?.id === 'string') {
                return parsed.payload.id;
            }
        } catch {
            // Fall back to regex extraction below.
        }

        return this.extractSessionIdFromContent(firstLine);
    }

    private extractSessionIdFromContent(rawContent: string): string | undefined {
        const explicit = rawContent.match(/"sessionId"\s*:\s*"([^"]+)"/);
        if (explicit?.[1]) {
            return explicit[1];
        }

        return this.extractUuid(rawContent);
    }

    private extractUuid(value: string): string | undefined {
        return value.match(ProviderSessionHistory.UUID_PATTERN)?.[0];
    }

    private extractCompletionSignalPath(promptSnapshot: string): string | undefined {
        return promptSnapshot.match(/Completion Signal Path:\s*([^\r\n]+)/i)?.[1]?.trim() ??
            promptSnapshot.match(/Completion signal path:\s*([^\r\n]+)/i)?.[1]?.trim();
    }

    private extractRunId(promptSnapshot: string): string | undefined {
        return promptSnapshot.match(/"runId"\s*:\s*"([^"]+)"/)?.[1];
    }

    private extractTaskMode(promptSnapshot: string): string | undefined {
        const mode = promptSnapshot.match(/^Task Mode:\s*([^\r\n]+)/im)?.[1]?.trim();
        return mode ? `Task Mode: ${mode}` : undefined;
    }

    private stripTaskNumbering(taskDescription: string): string {
        return taskDescription
            .replace(/^\s*\d+(?:\.\d+)*[.)]?\s*/, '')
            .replace(/^[-*]\s*/, '')
            .trim();
    }

    private isVerificationSession(normalizedContent: string): boolean {
        return normalizedContent.includes('you are verifying whether a single spec implementation task is truly complete') ||
            normalizedContent.includes('return exactly one json object and no markdown');
    }

    private normalize(value: string): string {
        return this.decodeCommonHtmlEntities(value)
            .replace(/\\/g, '/')
            .replace(/\/{2,}/g, '/')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private decodeCommonHtmlEntities(value: string): string {
        return value
            .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    private async readTextFile(filePath: string): Promise<string | undefined> {
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        } catch (error) {
            this.options.outputChannel?.appendLine(`[ProviderSessionHistory] Failed to read ${filePath}: ${error}`);
            return undefined;
        }
    }
}
