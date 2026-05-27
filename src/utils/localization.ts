import * as vscode from 'vscode';
import { getRuntimeValue } from '../runtime/runtimeSettings';

export type AutoCodeUiLanguage = 'auto' | 'en' | 'zh-CN';

export function getUiLanguage(): Exclude<AutoCodeUiLanguage, 'auto'> {
    const configured = getRuntimeValue<AutoCodeUiLanguage>('ui.language', 'auto');

    if (configured === 'en' || configured === 'zh-CN') {
        return configured;
    }

    return vscode.env.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function localize(english: string, chinese: string): string {
    return getUiLanguage() === 'zh-CN' ? chinese : english;
}
