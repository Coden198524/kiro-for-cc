import * as vscode from 'vscode';
import * as path from 'path';
import { parseSpecTaskLine } from './taskStatus';
import { TaskCompletionVerifier, VerifyAndMarkTaskDoneRequest } from './taskCompletionVerifier';

interface TaskCompletionSignalPayload {
    status?: string;
    taskFilePath?: string;
    lineNumber?: number;
    taskDescription?: string;
    runId?: string;
    reason?: string;
}

interface CompletionSignalValidationOptions {
    expectedRunId?: string;
    minModifiedAt?: number;
    lineNumberOverride?: number;
}

export interface TaskCompletionReconcileResult {
    detected: number;
    verified: number;
}

export interface TaskCompletionReconcileOptions {
    lineNumbers?: readonly number[];
    expectedRunIdsByLineNumber?: Record<number, string | undefined>;
    taskLineNumbersBySignalLineNumber?: Record<number, number | undefined>;
    minModifiedAt?: number;
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
        completionSignalPath?: string,
        expectedRunId?: string
    ): Promise<boolean> | undefined {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; not registering completion verification.');
            return undefined;
        }

        let handled = false;
        let resolveCompletion: (verified: boolean) => void = () => undefined;
        let completionResolved = false;
        let closeGraceTimer: NodeJS.Timeout | undefined;
        const minSignalModifiedAt = Date.now() - 2000;
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
                const useChinese = /[\u3400-\u9FFF]/.test(verificationRequest.taskDescription);
                this.outputChannel.appendLine(`[Task Complete] Verifying completion for line ${verificationRequest.lineNumber + 1}: ${verificationRequest.taskDescription}`);
                const verified = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: useChinese
                            ? `AutoCode 正在验证任务 ${verificationRequest.lineNumber + 1}: ${verificationRequest.taskDescription}`
                            : `AutoCode verifying task ${verificationRequest.lineNumber + 1}: ${verificationRequest.taskDescription}`,
                        cancellable: false
                    },
                    () => this.verifier.verifyAndMarkDone(verificationRequest, terminal)
                );
                this.outputChannel.appendLine(`[Task Complete] Completion verification result for line ${verificationRequest.lineNumber + 1}: ${verified ? 'verified' : 'not verified'}`);
                if (!verified) {
                    vscode.window.showWarningMessage(useChinese
                        ? `任务完成验证未通过：${verificationRequest.taskDescription}`
                        : `Task completion verification did not pass: ${verificationRequest.taskDescription}`);
                }
                finishCompletion(verified);
                return verified;
            } catch (error) {
                this.outputChannel.appendLine(`[Task Complete] Completion verification failed for line ${verificationRequest.lineNumber + 1}: ${error}`);
                const useChinese = /[\u3400-\u9FFF]/.test(verificationRequest.taskDescription);
                vscode.window.showWarningMessage(useChinese
                    ? `任务完成验证失败：${verificationRequest.taskDescription}`
                    : `Task completion verification failed: ${verificationRequest.taskDescription}`);
                finishCompletion(false);
                throw error;
            }
        };

        const runSignalVerification = async () => {
            const signalResult = completionSignalPath
                ? await this.resolveSignalResult(completionSignalPath, request.taskFilePath, {
                    expectedRunId,
                    minModifiedAt: expectedRunId ? minSignalModifiedAt : undefined
                })
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

        const stopWithoutSignal = () => {
            handled = true;
            clearCloseGraceTimer();
            closeDisposable.dispose();
            shellEndDisposable.dispose();
            signalDisposable?.dispose();
            finishCompletion(false);
        };

        const scheduleMissingSignalFailure = (source: 'terminal-close') => {
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
                        this.outputChannel.appendLine('[Task Complete] Completion signal did not arrive after terminal close grace period; pausing automatic task execution.');
                        stopWithoutSignal();
                    }

                    return undefined;
                }).catch(error => {
                    this.outputChannel.appendLine(`[Task Complete] Failed to check completion signal after terminal close: ${error}`);
                    if (!handled) {
                        stopWithoutSignal();
                    }
                });
            }, TaskCompletionService.TERMINAL_CLOSE_SIGNAL_GRACE_MS);
            this.unrefTimer(closeGraceTimer);
        };

        const shellEndDisposable = vscode.window.onDidEndTerminalShellExecution(async (event) => {
            if (event.terminal !== terminal) {
                return;
            }

            if (completionSignalPath) {
                await runSignalVerification();
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
                    scheduleMissingSignalFailure('terminal-close');
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
    ): Promise<boolean> | undefined {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; not registering batch completion signals.');
            return undefined;
        }

        const signalPaths = [...new Set(completionSignalPaths)];
        if (signalPaths.length === 0) {
            this.outputChannel.appendLine('[Task Complete] No batch completion signals were provided.');
            return Promise.resolve(true);
        }

        const disposables: vscode.Disposable[] = [];
        const verificationResults = new Map<string, boolean>();
        let completionResolved = false;
        let closeGraceTimer: NodeJS.Timeout | undefined;
        let terminalDisposable: vscode.Disposable = { dispose: () => undefined };
        let resolveCompletion: (verified: boolean) => void = () => undefined;
        const completionPromise = new Promise<boolean>(resolve => {
            resolveCompletion = resolve;
        });

        const cleanup = () => {
            if (closeGraceTimer) {
                clearTimeout(closeGraceTimer);
                closeGraceTimer = undefined;
            }

            disposables.forEach(disposable => disposable.dispose());
            terminalDisposable.dispose();
        };

        const finishCompletion = (verified: boolean) => {
            if (completionResolved) {
                return;
            }

            completionResolved = true;
            cleanup();
            resolveCompletion(verified);
        };

        const finishIfAllSignalsHandled = () => {
            if (signalPaths.every(signalPath => verificationResults.has(signalPath))) {
                finishCompletion(signalPaths.every(signalPath => verificationResults.get(signalPath)));
            }
        };

        const verifySignal = async (completionSignalPath: string) => {
            if (verificationResults.has(completionSignalPath)) {
                return verificationResults.get(completionSignalPath);
            }

            const signalResult = await this.resolveSignalResult(completionSignalPath, taskFilePath);
            if (!signalResult) {
                return undefined;
            }

            if (signalResult.status === 'blocked') {
                this.outputChannel.appendLine(`[Task Complete] Task reported blocked: ${signalResult.reason || completionSignalPath}`);
                verificationResults.set(completionSignalPath, false);
                finishIfAllSignalsHandled();
                return false;
            }

            try {
                this.outputChannel.appendLine(`[Task Complete] Verifying batch completion signal: ${completionSignalPath}`);
                const verified = await this.verifier.verifyAndMarkDone(signalResult.request, terminal);
                this.outputChannel.appendLine(`[Task Complete] Batch completion verification result for ${completionSignalPath}: ${verified ? 'verified' : 'not verified'}`);
                verificationResults.set(completionSignalPath, verified);
                finishIfAllSignalsHandled();
                return verified;
            } catch (error) {
                this.outputChannel.appendLine(`[Task Complete] Failed to verify batch completion signal ${completionSignalPath}: ${error}`);
                verificationResults.set(completionSignalPath, false);
                finishIfAllSignalsHandled();
                return false;
            }
        };

        for (const signalPath of signalPaths) {
            disposables.push(this.registerSignalMonitor(signalPath, () => verifySignal(signalPath)));
            this.outputChannel.appendLine(`[Task Complete] Watching completion signal: ${signalPath}`);
        }

        terminalDisposable = vscode.window.onDidCloseTerminal(async closedTerminal => {
            if (closedTerminal !== terminal) {
                return;
            }

            await Promise.all(signalPaths.map(signalPath => verifySignal(signalPath)));
            const missingSignals = signalPaths.filter(signalPath => !verificationResults.has(signalPath));
            if (missingSignals.length === 0) {
                finishIfAllSignalsHandled();
                return;
            }

            if (completionResolved || closeGraceTimer) {
                return;
            }

            this.outputChannel.appendLine(`[Task Complete] Batch terminal closed before all completion signals were ready; waiting ${TaskCompletionService.TERMINAL_CLOSE_SIGNAL_GRACE_MS}ms for remaining signals.`);
            closeGraceTimer = setTimeout(() => {
                closeGraceTimer = undefined;
                Promise.all(signalPaths.map(signalPath => verifySignal(signalPath))).then(() => {
                    const stillMissingSignals = signalPaths.filter(signalPath => !verificationResults.has(signalPath));
                    if (stillMissingSignals.length > 0) {
                        this.outputChannel.appendLine(`[Task Complete] Batch completion signals did not arrive: ${stillMissingSignals.join(', ')}`);
                        finishCompletion(false);
                        return;
                    }

                    finishIfAllSignalsHandled();
                }).catch(error => {
                    this.outputChannel.appendLine(`[Task Complete] Failed to verify batch completion signals after terminal close: ${error}`);
                    finishCompletion(false);
                });
            }, TaskCompletionService.TERMINAL_CLOSE_SIGNAL_GRACE_MS);
            this.unrefTimer(closeGraceTimer);
        });

        context.subscriptions.push(...disposables, terminalDisposable);
        return completionPromise;
    }

    async reconcileTaskCompletionSignals(
        taskFilePath: string,
        options: TaskCompletionReconcileOptions = {}
    ): Promise<TaskCompletionReconcileResult> {
        if (!this.verifier.isEnabled()) {
            this.outputChannel.appendLine('[Task Complete] Auto mark task done is disabled; skipping reconciliation.');
            return { detected: 0, verified: 0 };
        }

        const signalPaths = this.filterCompletionSignalPaths(
            await this.listCompletionSignalPaths(taskFilePath),
            options.lineNumbers,
            options.taskLineNumbersBySignalLineNumber
        );
        let verified = 0;

        for (const signalPath of signalPaths) {
            const signalLineNumber = this.parseCompletionSignalLineNumber(signalPath);
            const taskLineNumber = signalLineNumber === undefined
                ? undefined
                : options.taskLineNumbersBySignalLineNumber?.[signalLineNumber] ?? signalLineNumber;
            const signalResult = await this.resolveSignalResult(signalPath, taskFilePath, {
                expectedRunId: taskLineNumber === undefined ? undefined : options.expectedRunIdsByLineNumber?.[taskLineNumber],
                minModifiedAt: options.minModifiedAt,
                lineNumberOverride: taskLineNumber
            });
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

    private filterCompletionSignalPaths(
        signalPaths: string[],
        lineNumbers: readonly number[] | undefined,
        taskLineNumbersBySignalLineNumber: Record<number, number | undefined> | undefined
    ): string[] {
        if (!lineNumbers || lineNumbers.length === 0) {
            return signalPaths;
        }

        const allowedLineNumbers = new Set(lineNumbers);
        return signalPaths.filter(signalPath => {
            const lineNumber = this.parseCompletionSignalLineNumber(signalPath);
            if (lineNumber === undefined) {
                return false;
            }

            const taskLineNumber = taskLineNumbersBySignalLineNumber?.[lineNumber] ?? lineNumber;
            return allowedLineNumbers.has(lineNumber) || allowedLineNumbers.has(taskLineNumber);
        });
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
        fallbackTaskFilePath: string,
        validation: CompletionSignalValidationOptions = {}
    ): Promise<{ status: 'ready_for_verification'; request: VerifyAndMarkTaskDoneRequest } | { status: 'blocked'; reason?: string } | undefined> {
        const signalPayload = await this.readCompletionSignal(completionSignalPath);
        if (!signalPayload) {
            return undefined;
        }

        if (validation.expectedRunId) {
            if (signalPayload.runId) {
                if (signalPayload.runId !== validation.expectedRunId) {
                    this.outputChannel.appendLine(`[Task Complete] Ignoring completion signal with mismatched runId: ${completionSignalPath}`);
                    return undefined;
                }
            } else if (!await this.isFreshSignalWithoutRunId(completionSignalPath, validation.minModifiedAt)) {
                return undefined;
            }
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

        const lineNumber = validation.lineNumberOverride ??
            this.parseCompletionSignalLineNumber(completionSignalPath) ??
            (typeof signalPayload.lineNumber === 'number' ? signalPayload.lineNumber : undefined);
        if (lineNumber === undefined) {
            this.outputChannel.appendLine(`[Task Complete] Could not infer task line from signal path: ${completionSignalPath}`);
            return undefined;
        }

        const taskFilePath = fallbackTaskFilePath;
        const taskDescription = await this.readTaskDescription(taskFilePath, lineNumber) || signalPayload.taskDescription;
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

    private async isFreshSignalWithoutRunId(completionSignalPath: string, minModifiedAt: number | undefined): Promise<boolean> {
        if (minModifiedAt === undefined) {
            return true;
        }

        const modifiedAt = await this.readCompletionSignalModifiedAt(completionSignalPath);
        if (modifiedAt === undefined) {
            this.outputChannel.appendLine(`[Task Complete] Ignoring completion signal without runId because file modified time is unavailable: ${completionSignalPath}`);
            return false;
        }

        if (modifiedAt < minModifiedAt) {
            this.outputChannel.appendLine(`[Task Complete] Ignoring stale completion signal without runId: ${completionSignalPath}`);
            return false;
        }

        this.outputChannel.appendLine(`[Task Complete] Accepting completion signal without runId because it was written after this task run started: ${completionSignalPath}`);
        return true;
    }

    private async readCompletionSignalModifiedAt(completionSignalPath: string): Promise<number | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(completionSignalPath));
            return typeof stat.mtime === 'number' ? stat.mtime : undefined;
        } catch (error) {
            this.outputChannel.appendLine(`[Task Complete] Failed to stat completion signal ${completionSignalPath}: ${error}`);
            return undefined;
        }
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
            const text = this.stripUtf8Bom(Buffer.from(content).toString());
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

    private stripUtf8Bom(text: string): string {
        return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    }

    private parseCompletionSignal(text: string): TaskCompletionSignalPayload {
        try {
            const parsed = JSON.parse(text) as Partial<TaskCompletionSignalPayload>;
            return {
                status: typeof parsed.status === 'string' ? parsed.status : undefined,
                taskFilePath: typeof parsed.taskFilePath === 'string' ? parsed.taskFilePath : undefined,
                lineNumber: typeof parsed.lineNumber === 'number' ? parsed.lineNumber : undefined,
                taskDescription: typeof parsed.taskDescription === 'string' ? parsed.taskDescription : undefined,
                runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
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
            runId: this.matchJsonStringField(text, 'runId'),
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
            new vscode.RelativePattern(path.dirname(signalUri.fsPath), path.basename(signalUri.fsPath))
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
            this.unrefTimer(timer);
        };

        watcher.onDidCreate(uri => trigger(uri, 'watcher'));
        watcher.onDidChange(uri => trigger(uri, 'watcher'));
        const startupTimer = setTimeout(() => {
            vscode.workspace.fs.stat(signalUri).then(
                () => trigger(signalUri, 'startup'),
                () => undefined
            );
        }, 0);
        this.unrefTimer(startupTimer);

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
        this.unrefTimer(pollTimer);

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

    private unrefTimer(timer: NodeJS.Timeout): void {
        timer.unref?.();
    }
}
