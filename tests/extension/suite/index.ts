import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 15000
    });

    for (const filePath of collectTestFiles(__dirname)) {
        mocha.addFile(filePath);
    }

    return new Promise((resolve, reject) => {
        mocha.run(failures => {
            if (failures > 0) {
                reject(new Error(`${failures} extension host test(s) failed.`));
                return;
            }

            resolve();
        });
    });
}

function collectTestFiles(directoryPath: string): string[] {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTestFiles(entryPath));
        } else if (/\.ehost\.js$/i.test(entry.name)) {
            files.push(entryPath);
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}
