import * as vscode from 'vscode';
import * as path from 'path';

export interface SpecDescriptionInputOptions {
    title: string;
    prompt: string;
    placeholder: string;
}

interface SpecDescriptionAttachment {
    name: string;
    type?: string;
    size?: number;
    kind: 'text' | 'data';
    content?: string;
    dataUrl?: string;
}

type SpecDescriptionMessage =
    | { command: 'submit'; text?: string; attachments?: SpecDescriptionAttachment[] }
    | { command: 'cancel' };

export class SpecDescriptionInput {
    private static readonly MAX_INLINE_TEXT_LENGTH = 120000;

    static async prompt(options: SpecDescriptionInputOptions): Promise<string | undefined> {
        if (typeof vscode.window.createWebviewPanel !== 'function') {
            return vscode.window.showInputBox({
                title: options.title,
                prompt: options.prompt,
                placeHolder: options.placeholder,
                ignoreFocusOut: false
            });
        }

        return new Promise(resolve => {
            let settled = false;
            let messageDisposable: vscode.Disposable | undefined;
            let disposeDisposable: vscode.Disposable | undefined;
            const panel = vscode.window.createWebviewPanel(
                'autocodeSpecDescriptionInput',
                options.title,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const finish = (value: string | undefined): void => {
                if (settled) {
                    return;
                }

                settled = true;
                messageDisposable?.dispose();
                disposeDisposable?.dispose();
                if (value !== undefined) {
                    panel.dispose();
                }
                resolve(value);
            };

            messageDisposable = panel.webview.onDidReceiveMessage(async (message: SpecDescriptionMessage) => {
                if (message.command === 'cancel') {
                    finish(undefined);
                    panel.dispose();
                    return;
                }

                if (message.command === 'submit') {
                    const text = (message.text ?? '').trim();
                    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
                    if (text.length === 0 && attachments.length === 0) {
                        return;
                    }

                    try {
                        const description = await this.appendAttachmentsToDescription(text, attachments);
                        finish(description || undefined);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to read dropped files: ${error}`);
                    }
                }
            });

            disposeDisposable = panel.onDidDispose(() => {
                finish(undefined);
            });

            panel.webview.html = this.renderHtml(options);
        });
    }

    private static async appendAttachmentsToDescription(
        description: string,
        attachments: SpecDescriptionAttachment[]
    ): Promise<string> {
        const validAttachments = attachments.filter(attachment => attachment.name && attachment.kind);
        if (validAttachments.length === 0) {
            return description;
        }

        const sections: string[] = ['## Attached Files'];
        for (let index = 0; index < validAttachments.length; index++) {
            const attachment = validAttachments[index];
            sections.push(await this.formatAttachmentSection(attachment, index + 1));
        }

        return [description, sections.join('\n\n')]
            .filter(part => part.trim().length > 0)
            .join('\n\n');
    }

    private static async formatAttachmentSection(
        attachment: SpecDescriptionAttachment,
        index: number
    ): Promise<string> {
        const name = attachment.name.trim();
        const type = attachment.type || 'unknown';
        const size = typeof attachment.size === 'number' ? attachment.size : 0;

        if (attachment.kind === 'text') {
            const content = attachment.content ?? '';
            const truncated = content.length > this.MAX_INLINE_TEXT_LENGTH;
            const displayedContent = truncated
                ? content.slice(0, this.MAX_INLINE_TEXT_LENGTH)
                : content;
            const truncationNote = truncated
                ? `\n\n[Text file truncated to ${this.MAX_INLINE_TEXT_LENGTH} characters.]`
                : '';

            return [
                `### ${index}. ${name}`,
                `Type: ${type}`,
                `Size: ${size} bytes`,
                '',
                '```text',
                `${displayedContent}${truncationNote}`,
                '```'
            ].join('\n');
        }

        const savedPath = await this.saveAttachmentDataFile(attachment, index);
        return [
            `### ${index}. ${name}`,
            `Type: ${type}`,
            `Size: ${size} bytes`,
            savedPath
                ? `Saved path: ${savedPath}`
                : 'Saved path: unavailable because no workspace folder is open',
            this.isImageAttachment(attachment)
                ? 'Use this image as visual reference when creating the spec.'
                : 'Use this file as additional reference when creating the spec.'
        ].join('\n');
    }

    private static async saveAttachmentDataFile(
        attachment: SpecDescriptionAttachment,
        index: number
    ): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !attachment.dataUrl) {
            return undefined;
        }

        const buffer = this.decodeDataUrl(attachment.dataUrl);
        if (!buffer) {
            return undefined;
        }

        const attachmentDir = path.join(workspaceFolder.uri.fsPath, '.autocode', 'spec-input-assets');
        const filePath = path.join(attachmentDir, `${index}-${this.sanitizeFileName(attachment.name)}`);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(attachmentDir));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), buffer);
        return filePath;
    }

    private static decodeDataUrl(dataUrl: string): Uint8Array | undefined {
        const match = dataUrl.match(/^data:[^;]*;base64,(.+)$/);
        if (!match) {
            return undefined;
        }

        return Buffer.from(match[1], 'base64');
    }

    private static isImageAttachment(attachment: SpecDescriptionAttachment): boolean {
        return (attachment.type ?? '').toLowerCase().startsWith('image/');
    }

    private static sanitizeFileName(fileName: string): string {
        const sanitized = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim();
        return sanitized || 'attachment';
    }

    private static renderHtml(options: SpecDescriptionInputOptions): string {
        const nonce = this.createNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(options.title)}</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        .root {
            max-width: 920px;
            margin: 0 auto;
        }
        h1 {
            margin: 0 0 8px;
            font-size: 20px;
            font-weight: 600;
        }
        p {
            margin: 0 0 14px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
        }
        textarea {
            box-sizing: border-box;
            width: 100%;
            min-height: 300px;
            resize: vertical;
            padding: 12px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.5;
            outline: none;
        }
        textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        .dropzone {
            margin-top: 12px;
            padding: 14px;
            border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            background: var(--vscode-editor-inactiveSelectionBackground);
        }
        .dropzone.dragging {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-list-hoverBackground);
        }
        .dropzone-title {
            margin-bottom: 4px;
            font-weight: 600;
        }
        .dropzone-detail {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            line-height: 1.4;
        }
        .file-input-label {
            display: inline-block;
            margin-top: 8px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
        }
        #fileInput {
            display: none;
        }
        .attachments {
            margin: 10px 0 0;
            padding: 0;
            list-style: none;
        }
        .attachments li {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 6px 0;
            border-top: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            font-size: 12px;
        }
        .remove {
            min-width: auto;
            padding: 2px 8px;
        }
        .error {
            min-height: 18px;
            margin-top: 8px;
            color: var(--vscode-errorForeground);
            font-size: 12px;
        }
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-top: 12px;
        }
        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .actions {
            display: flex;
            gap: 8px;
        }
        button {
            min-width: 92px;
            padding: 6px 14px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 2px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
        }
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        button:disabled {
            opacity: 0.55;
            cursor: default;
        }
    </style>
</head>
<body>
    <main class="root">
        <h1>${this.escapeHtml(options.title)}</h1>
        <p>${this.escapeHtml(options.prompt)}</p>
        <textarea id="description" aria-label="Spec description" placeholder="${this.escapeHtml(options.placeholder)}"></textarea>
        <section id="dropzone" class="dropzone" aria-label="Drop files or images">
            <div class="dropzone-title">Drop files or images here</div>
            <div class="dropzone-detail">Text files are inserted into the spec request. Images and binary files are saved under .autocode/spec-input-assets and referenced by path.</div>
            <label class="file-input-label" for="fileInput">Choose files</label>
            <input id="fileInput" type="file" multiple>
            <ul id="attachments" class="attachments"></ul>
            <div id="error" class="error"></div>
        </section>
        <div class="footer">
            <div class="hint">Ctrl+Enter submits. Esc cancels.</div>
            <div class="actions">
                <button id="cancel" class="secondary" type="button">Cancel</button>
                <button id="submit" type="button" disabled>Create Spec</button>
            </div>
        </div>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const textarea = document.getElementById('description');
        const submit = document.getElementById('submit');
        const cancel = document.getElementById('cancel');
        const dropzone = document.getElementById('dropzone');
        const fileInput = document.getElementById('fileInput');
        const attachmentsList = document.getElementById('attachments');
        const error = document.getElementById('error');
        const attachments = [];
        const maxFileSize = 5 * 1024 * 1024;

        const isTextFile = file => {
            if (file.type && (file.type.startsWith('text/') || file.type === 'application/json' || file.type === 'application/xml')) {
                return true;
            }
            return /\\.(txt|md|markdown|json|jsonl|yaml|yml|xml|csv|ts|tsx|js|jsx|css|scss|html|cs|cpp|c|h|hpp|lua|py|java|go|rs|toml|ini|log)$/i.test(file.name);
        };

        const formatBytes = value => {
            if (value < 1024) {
                return value + ' B';
            }
            if (value < 1024 * 1024) {
                return (value / 1024).toFixed(1) + ' KB';
            }
            return (value / (1024 * 1024)).toFixed(1) + ' MB';
        };

        const updateSubmitState = () => {
            submit.disabled = textarea.value.trim().length === 0 && attachments.length === 0;
        };

        const renderAttachments = () => {
            attachmentsList.innerHTML = '';
            for (const [index, attachment] of attachments.entries()) {
                const item = document.createElement('li');
                const label = document.createElement('span');
                label.textContent = attachment.name + ' · ' + (attachment.type || 'unknown') + ' · ' + formatBytes(attachment.size || 0);
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'secondary remove';
                remove.textContent = 'Remove';
                remove.addEventListener('click', () => {
                    attachments.splice(index, 1);
                    renderAttachments();
                    updateSubmitState();
                });
                item.append(label, remove);
                attachmentsList.append(item);
            }
        };

        const readFile = file => new Promise((resolve, reject) => {
            if (file.size > maxFileSize) {
                reject(new Error(file.name + ' is larger than 5 MB.'));
                return;
            }

            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Could not read ' + file.name));
            reader.onload = () => {
                if (isTextFile(file)) {
                    resolve({
                        kind: 'text',
                        name: file.name,
                        type: file.type || 'text/plain',
                        size: file.size,
                        content: String(reader.result || '')
                    });
                    return;
                }

                resolve({
                    kind: 'data',
                    name: file.name,
                    type: file.type || 'application/octet-stream',
                    size: file.size,
                    dataUrl: String(reader.result || '')
                });
            };

            if (isTextFile(file)) {
                reader.readAsText(file);
            } else {
                reader.readAsDataURL(file);
            }
        });

        const addFiles = async fileList => {
            error.textContent = '';
            for (const file of Array.from(fileList || [])) {
                try {
                    attachments.push(await readFile(file));
                } catch (readError) {
                    error.textContent = String(readError && readError.message ? readError.message : readError);
                }
            }
            renderAttachments();
            updateSubmitState();
        };

        textarea.addEventListener('input', updateSubmitState);
        textarea.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                submit.click();
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                cancel.click();
            }
        });
        submit.addEventListener('click', () => {
            const text = textarea.value.trim();
            if (text.length === 0 && attachments.length === 0) {
                return;
            }
            vscode.postMessage({ command: 'submit', text, attachments });
        });
        cancel.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        fileInput.addEventListener('change', event => {
            addFiles(event.target.files);
            fileInput.value = '';
        });
        dropzone.addEventListener('dragenter', event => {
            event.preventDefault();
            dropzone.classList.add('dragging');
        });
        dropzone.addEventListener('dragover', event => {
            event.preventDefault();
            dropzone.classList.add('dragging');
        });
        dropzone.addEventListener('dragleave', event => {
            if (!dropzone.contains(event.relatedTarget)) {
                dropzone.classList.remove('dragging');
            }
        });
        dropzone.addEventListener('drop', event => {
            event.preventDefault();
            dropzone.classList.remove('dragging');
            addFiles(event.dataTransfer.files);
        });

        textarea.focus();
        updateSubmitState();
    </script>
</body>
</html>`;
    }

    private static escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private static createNonce(): string {
        return Math.random().toString(36).slice(2, 12);
    }
}
