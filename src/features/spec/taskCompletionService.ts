import * as vscode from 'vscode';
import * as path from 'path';
import { parseSpecTaskLine } from './taskStatus';
import { TaskCompletionVerifier, VerifyAndMarkTaskDoneRequest } from './taskCompletionVerifier';

interface TaskCompletionSignalPayload {
    status?: string;
    taskFilePath?: string;
    lineNumber?: number;
    taskDescription?: string;
    reason?: string;
}

export interface TaskCompletionReconcileResult {
    detected: number;
    verified: number;
}

export class TaskCompletionService {
    private static readonly SIGNAL_POLL_INTERVAL_MS = 2000;
    private static readonly SIGNAL_POLL_TIMEOUT_MS = 30 * 60 * 1000;
    private static readonly TERMINAL_CLOSE_SIGNAL_GRACE_MS = 10000;

    constructor(
        private verifier: TaskCompletionVerifier,
        private outputChannel: vscode.OutputChannel
    ) { }

    registerTaskCompletion(
        context: vscode.ExtensionContext,
        terminal: vscode.Terminal,
        request: VerifyAndMarkTaskDoneRequest,
        completionSignalPath?: string
    ): Promise<boolean> | undefined {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; not registering completion verification.');
            return undefined;
        }

        let handled = false;
        let resolveCompletion: (verified: boolean) => void = () => undefined;
        let completionResolved = false;
        let closeGraceTimer: NodeJS.Timeout | undefined;
        const completionPromise = new Promise<boolean>(resolve => {
            resolveCompletion = resolve;
        });
        const clearCloseGraceTimer = () => {
            if (closeGraceTimer) {
                clearTimeout(closeGraceTimer);
                closeGraceTimer = undefined;
            }
        };
        const finishCompletion = (verified: boolean) => {
            if (completionResolved) {
                return;
            }

            completionResolved = true;
            resolveCompletion(verified);
        };
        const runVerification = async (verificationRequest: VerifyAndMarkTaskDoneRequest) => {
            if (handled) {
                return completionPromise;
            }

            handled = true;
            clearCloseGraceTimer();
            closeDisposable.dispose();
            shellEndDisposable.dispose();
            signalDisposable?.dispose();

            try {
                const verified = await this.verifier.verifyAndMarkDone(verificationRequest);
                finishCompletion(verified);
                return verified;
            } catch (error) {
                finishCompletion(false);
                throw error;
            }
        };

        const runSignalVerification = async () => {
            const signalResult = completionSignalPath
                ? await this.resolveSignalResult(completionSignalPath, request.taskFilePath)
                : undefined;
            if (!signalResult) {
                this.outputChannel.appendLine(`[Task Complete] Completion signal is not ready yet: ${completionSignalPath ?? '(not available)'}`);
                return false;
            }

            if (signalResult.status === 'blocked') {
                this.outputChannel.appendLine(`[Task Complete] Task reported blocked: ${signalResult.reason || completionSignalPath}`);
                handled = true;
                clearCloseGraceTimer();
                finishCompletion(false);
                closeDisposable.dispose();
                shellEndDisposable.dispose();
                signalDisposable?.dispose();
                return false;
            }

            return runVerification(signalResult.request);
        };

        const scheduleMissingSignalFallback = (source: 'shell-end' | 'terminal-close') => {
            if (handled || closeGraceTimer) {
                return;
            }

            this.outputChannel.appendLine(`[Task Complete] ${source} occurred before completion signal was ready; waiting ${TaskCompletionService.TERMINAL_CLOSE_SIGNAL_GRACE_MS}ms for ${completionSignalPath}.`);
            closeGraceTimer = setTimeout(() => {
                closeGraceTimer = undefined;
                if (handled) {
                    return;
                }

                runSignalVerification().then(signalVerified => {
                    if (!signalVerified && !handled) {
                        this.outputChannel.appendLine('[Task Complete] Completion signal did not arrive after terminal close grace period; running fallback verification.');
                        return runVerification(request);
                    }

                    return undefined;
                }).catch(error => {
                    this.outputChannel.appendLine(`[Task Complete] Failed to run terminal close fallback verification: ${error}`);
                });
            }, TaskCompletionService.TERMINAL_CLOSE_SIGNAL_GRACE_MS);
        };

        const shellEndDisposable = vscode.window.onDidEndTerminalShellExecution(async (event) => {
            if (event.terminal !== terminal) {
                return;
            }

            if (completionSignalPath) {
                const signalVerified = await runSignalVerification();
                if (!signalVerified && !handled) {
                    scheduleMissingSignalFallback('shell-end');
                }
                return;
            }

            await runVerification(request);
        });

        const closeDisposable = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
            if (closedTerminal !== terminal) {
                return;
            }

            if (completionSignalPath) {
                const signalVerified = await runSignalVerification();
                if (!signalVerified && !handled) {
                    scheduleMissingSignalFallback('terminal-close');
                }
                return;
            }

            await runVerification(request);
        });

        const signalDisposable = completionSignalPath
            ? this.registerSignalMonitor(completionSignalPath, async () => {
                await runSignalVerification();
            })
            : undefined;

        if (completionSignalPath) {
            this.outputChannel.appendLine(`[Task Complete] Watching completion signal: ${completionSignalPath}`);
        }

        context.subscriptions.push(...[closeDisposable, shellEndDisposable, signalDisposable].filter((item): item is vscode.Disposable => Boolean(item)));
        return completionPromise;
    }

    registerTaskCompletionSignals(
        context: vscode.ExtensionContext,
        terminal: vscode.Terminal,
        taskFilePath: string,
        completionSignalPaths: string[]
    ): void {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; not registering batch completion signals.');
            return;
        }

        const disposables: vscode.Disposable[] = [];
        const handledSignals = new Set<string>();

        const verifySignal = async (completionSignalPath: string) => {
            if (handledSignals.has(completionSignalPath)) {
                return;
            }

            const signalResult = await this.resolveSignalResult(completionSignalPath, taskFilePath);
            if (!signalResult) {
                return;
            }

            handledSignals.add(completionSignalPath);
            if (signalResult.status === 'blocked') {
                this.outputChannel.appendLine(`[Task Complete] Task reported blocked: ${signalResult.reason || completionSignalPath}`);
                return;
            }

            await this.verifier.verifyAndMarkDone(signalResult.request);
        };

        for (const signalPath of completionSignalPaths) {
            disposables.push(this.registerSignalMonitor(signalPath, () => verifySignal(signalPath)));
            this.outputChannel.appendLine(`[Task Complete] Watching completion signal: ${signalPath}`);
        }

        const terminalDisposable = vscode.window.onDidCloseTerminal(async closedTerminal => {
            if (closedTerminal !== terminal) {
                return;
            }

            for (const signalPath of completionSignalPaths) {
                await verifySignal(signalPath);
            }

            disposables.forEach(disposable => disposable.dispose());
            terminalDisposable.dispose();
        });

        context.subscriptions.push(...disposables, terminalDisposable);
    }

    async reconcileTaskCompletionSignals(taskFilePath: string): Promise<TaskCompletionReconcileResult> {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; skipping reconciliation.');
            return { detected: 0, verified: 0 };
        }

        const signalPaths = await this.listCompletionSignalPaths(taskFilePath);
        let verified = 0;

        for (const signalPath of signalPaths) {
            const signalResult = await this.resolveSignalResult(signalPath, taskFilePath);
            if (!signalResult || signalResult.status === 'blocked') {
                continue;
            }

            if (await this.verifier.verifyAndMarkDone(signalResult.request)) {
                verified += 1;
            }
        }

        this.outputChannel.appendLine(`[Task Complete] Reconciled completion signals: detected=${signalPaths.length}, verified=${verified}`);
        return {
            detected: signalPaths.length,
            verified
        };
    }

    private async listCompletionSignalPaths(taskFilePath: string): Promise<string[]> {
        const signalDir = path.join(path.dirname(taskFilePath), '.autocode');
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(signalDir));
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && /^task-completion-\d+\.json$/.test(name))
                .map(([name]) => path.join(signalDir, name))
                .sort((a, b) => (this.parseCompletionSignalLineNumber(a) ?? 0) - (this.parseCompletionSignalLineNumber(b) ?? 0));
        } catch (error) {
            this.outputChannel.appendLine(`[Task Complete] Failed to list completion signals for ${taskFilePath}: ${error}`);
            return [];
        }
    }

    private async resolveSignalResult(
        completionSignalPath: string,
        fallbackTaskFilePath: string
    ): Promise<{ status: 'ready_for_verification'; request: VerifyAndMarkTaskDoneRequest } | { status: 'blocked'; reason?: string } | undefined> {
        const signalPayload = await this.readCompletionSignal(completionSignalPath);
        if (!signalPayload) {
            return undefined;
        }

        if (signalPayload.status === 'blocked') {
            return {
                status: 'blocked',
                reason: signalPayload.reason
            };
        }

        if (signalPayload.status && signalPayload.status !== 'ready_for_verification') {
            this.outputChannel.appendLine(`[Task Complete] Ignoring completion signal with status ${signalPayload.status}: ${completionSignalPath}`);
            return undefined;
        }

        const lineNumber = typeof signalPayload.lineNumber === 'number'
            ? signalPayload.lineNumber
            : this.parseCompletionSignalLineNumber(completionSignalPath);
        if (lineNumber === undefined) {
            this.outputChannel.appendLine(`[Task Complete] Could not infer task line from signal path: ${completionSignalPath}`);
            return undefined;
        }

        const taskFilePath = signalPayload.taskFilePath || fallbackTaskFilePath;
        const taskDescription = signalPayload.taskDescription || await this.readTaskDescription(taskFilePath, lineNumber);
        if (!taskDescription) {
            this.outputChannel.appendLine(`[Task Complete] Could not resolve task description for signal: ${completionSignalPath}`);
            return undefined;
        }

        return {
            status: 'ready_for_verification',
            request: {
                taskFilePath,
                lineNumber,
                taskDescription
            }
        };
    }

    private parseCompletionSignalLineNumber(completionSignalPath: string): number | undefined {
        const match = path.basename(completionSignalPath).match(/^task-completion-(\d+)\.json$/);
        if (!match) {
            return undefined;
        }

        return Number(match[1]) - 1;
    }

    private async readTaskDescription(taskFilePath: string, lineNumber: number): Promise<string | undefined> {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(taskFilePath));
            if (lineNumber < 0 || lineNumber >= document.lineCount) {
                return undefined;
            }

            return parseSpecTaskLine(document.lineAt(lineNumber).text)?.description;
        } catch (error) {
            this.outputChannel.appendLine(`[Task Complete] Failed to read task line ${lineNumber + 1} from ${taskFilePath}: ${error}`);
            return undefined;
        }
    }

    private async readCompletionSignal(completionSignalPath: string): Promise<TaskCompletionSignalPayload | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(completionSignalPath));
            const text = Buffer.from(content).toString();
            if (!text.trim()) {
                this.outputChannel.appendLine(`[Task Complete] Completion signal is empty: ${completionSignalPath}`);
                return undefined;
            }

            return this.parseCompletionSignal(text);
        } catch (error) {
            this.outputChannel.appendLine(`[Task Complete] Failed to read completion signal ${completionSignalPath}: ${error}`);
            return undefined;
        }
    }

    private parseCompletionSignal(text: string): TaskCompletionSignalPayload {
        try {
            const parsed = JSON.parse(text) as Partial<TaskCompletionSignalPayload>;
            return {
                status: typeof parsed.status === 'string' ? parsed.status : undefined,
                taskFilePath: typeof parsed.taskFilePath === 'string' ? parsed.taskFilePath : undefined,
                lineNumber: typeof parsed.lineNumber === 'number' ? parsed.lineNumber : undefined,
                taskDescription: typeof parsed.taskDescription === 'string' ? parsed.taskDescription : undefined,
                reason: typeof parsed.reason === 'string' ? parsed.reason : undefined
            };
        } catch (error) {
            this.outputChannel.appendLine(`[Task Complete] Failed to parse completion signal JSON, using best-effort fields: ${error}`);
            return this.parseLooseCompletionSignal(text);
        }
    }

    private parseLooseCompletionSignal(text: string): TaskCompletionSignalPayload {
        const lineNumberMatch = text.match(/"lineNumber"\s*:\s*(\d+)/);
        return {
            status: this.matchJsonStringField(text, 'status'),
            taskFilePath: this.matchJsonStringField(text, 'taskFilePath'),
            lineNumber: lineNumberMatch ? Number(lineNumberMatch[1]) : undefined,
            taskDescription: this.matchJsonStringField(text, 'taskDescription'),
            reason: this.matchJsonStringField(text, 'reason')
        };
    }

    private matchJsonStringField(text: string, fieldName: string): string | undefined {
        const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`"${escapedFieldName}"\\s*:\\s*"([^"\\r\\n]*)`));
        return match?.[1];
    }

    private registerSignalMonitor(completionSignalPath: string, onSignal: () => Promise<unknown>): vscode.Disposable {
        const signalUri = vscode.Uri.file(completionSignalPath);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(signalUri.fsPath)), path.basename(signalUri.fsPath))
        );
        let timer: NodeJS.Timeout | undefined;
        let disposed = false;
        const startedAt = Date.now();

        const trigger = (uri: vscode.Uri, source: 'watcher' | 'poll' | 'startup') => {
            if (disposed) {
                return;
            }

            if (this.normalizeFsPath(uri.fsPath) !== this.normalizeFsPath(signalUri.fsPath)) {
                return;
            }

            this.outputChannel.appendLine(`[Task Complete] Completion signal detected by ${source}: ${uri.fsPath}`);

            if (timer) {
                clearTimeout(timer);
            }

            timer = setTimeout(() => {
                onSignal().catch(error => {
                    this.outputChannel.appendLine(`[Task Complete] Failed to verify completion signal: ${error}`);
                });
            }, 500);
        };

        watcher.onDidCreate(uri => trigger(uri, 'watcher'));
        watcher.onDidChange(uri => trigger(uri, 'watcher'));
        setTimeout(() => {
            vscode.workspace.fs.stat(signalUri).then(
                () => trigger(signalUri, 'startup'),
                () => undefined
            );
        }, 0);

        const pollTimer = setInterval(() => {
            if (disposed) {
                return;
            }

            if (Date.now() - startedAt > TaskCompletionService.SIGNAL_POLL_TIMEOUT_MS) {
                this.outputChannel.appendLine(`[Task Complete] Stopped polling completion signal after timeout: ${signalUri.fsPath}`);
                clearInterval(pollTimer);
                return;
            }

            vscode.workspace.fs.stat(signalUri).then(
                () => trigger(signalUri, 'poll'),
                () => undefined
            );
        }, TaskCompletionService.SIGNAL_POLL_INTERVAL_MS);

        return {
            dispose: () => {
                disposed = true;
                if (timer) {
                    clearTimeout(timer);
                }
                clearInterval(pollTimer);
                watcher.dispose();
            }
        };
    }

    private normalizeFsPath(filePath: string): string {
        const normalized = path.normalize(filePath);
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
    }
}
