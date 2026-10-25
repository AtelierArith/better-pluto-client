import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);

function requestedVersion(args) {
    const index = args.indexOf('--code-version');
    if (index >= 0 && args[index + 1]) {
        return args[index + 1];
    }
    const inline = args.find(arg => arg.startsWith('--code-version='));
    return inline ? inline.slice('--code-version='.length) : 'stable';
}

function withoutCodeVersion(args) {
    const result = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--code-version') {
            index++;
            continue;
        }
        if (args[index].startsWith('--code-version=')) {
            continue;
        }
        result.push(args[index]);
    }
    return result;
}

function executableCandidates(downloadedExecutable) {
    if (process.platform !== 'darwin') {
        return [downloadedExecutable];
    }
    const macOSDirectory = path.dirname(downloadedExecutable);
    return [
        downloadedExecutable,
        path.join(macOSDirectory, 'Electron'),
        path.join(macOSDirectory, 'Code'),
    ];
}

async function findExecutable(downloadedExecutable) {
    for (const candidate of executableCandidates(downloadedExecutable)) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Try the next executable name used by the downloaded VS Code build.
        }
    }
    throw new Error(`Could not find a VS Code executable near ${downloadedExecutable}`);
}

async function downloadExecutable(version) {
    let downloadedExecutable = await downloadAndUnzipVSCode(version);
    try {
        return await findExecutable(downloadedExecutable);
    } catch (error) {
        const installationRoot = path.resolve(path.dirname(downloadedExecutable), '../../..');
        const incompleteMarker = path.join(installationRoot, 'is-complete');
        if (!installationRoot.startsWith(path.join(repositoryRoot, '.vscode-test')) ||
            !await fs.stat(incompleteMarker).then(() => true).catch(() => false)) {
            throw error;
        }
        await fs.rm(installationRoot, { recursive: true, force: true });
        downloadedExecutable = await downloadAndUnzipVSCode(version);
        return findExecutable(downloadedExecutable);
    }
}

async function main() {
    const version = requestedVersion(rawArgs);
    const executable = await downloadExecutable(version);
    const configPath = path.join(repositoryRoot, `.vscode-test-runtime-${process.pid}.mjs`);
    const config = `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'node_modules/@vscode/test-cli/out/index.mjs')).href)};

export default defineConfig({
    files: 'out/test/**/*.test.js',
    extensionDevelopmentPath: ${JSON.stringify(repositoryRoot)},
    version: ${JSON.stringify(version)},
    useInstallation: { fromPath: ${JSON.stringify(executable)} },
});
`;

    await fs.writeFile(configPath, config, 'utf8');
    try {
        const cli = path.join(repositoryRoot, 'node_modules/@vscode/test-cli/out/bin.mjs');
        const child = spawn(process.execPath, [cli, '--config', configPath, ...withoutCodeVersion(rawArgs)], {
            cwd: repositoryRoot,
            stdio: 'inherit',
        });
        const exitCode = await new Promise(resolve => {
            child.on('error', error => {
                console.error(error);
                resolve(1);
            });
            child.on('exit', (code, signal) => {
                resolve(code ?? (signal ? 1 : 0));
            });
        });
        process.exitCode = exitCode;
    } finally {
        await fs.rm(configPath, { force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
