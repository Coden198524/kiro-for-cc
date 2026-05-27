import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite');
    const testWorkspace = path.resolve(extensionDevelopmentPath, '.vscode-test-workspace');

    fs.mkdirSync(testWorkspace, { recursive: true });

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
            testWorkspace,
            '--disable-extensions'
        ]
    });
}

main().catch(error => {
    console.error('Failed to run AutoCode extension host tests:', error);
    process.exit(1);
});
