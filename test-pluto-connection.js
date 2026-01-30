/**
 * Test script for PlutoConnection
 * Run with: node test-pluto-connection.js
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const { encode, decode } = require('@msgpack/msgpack');
const net = require('net');

// Generate UUID without external dependency
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Find available port
async function findPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function main() {
    const port = await findPort();
    console.log(`Using port: ${port}`);

    const notebookPath = './samples/Basic.jl';

    // Julia code to start Pluto
    const juliaCode = `
        import Pluto

        session = Pluto.ServerSession(;
            options = Pluto.Configuration.from_flat_kwargs(;
                launch_browser = false,
                port = ${port},
                require_secret_for_access = false,
                require_secret_for_open_links = false,
            )
        )

        notebook = Pluto.SessionActions.open(session, "${notebookPath}"; run_async=true)

        println("PLUTO_READY")
        println("NOTEBOOK_ID=", string(notebook.notebook_id))
        flush(stdout)

        Pluto.run(session)
    `;

    console.log('Starting Pluto server...');
    const juliaProcess = spawn('julia', ['--project=@.', '-e', juliaCode], {
        cwd: __dirname,
    });

    let notebookId = null;

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let wsConnected = false;

    juliaProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdoutBuffer += text;
        console.log('[Julia stdout]', text.trim());

        const match = stdoutBuffer.match(/NOTEBOOK_ID=([a-f0-9-]+)/);
        if (match && !notebookId) {
            notebookId = match[1];
            console.log('Notebook ID:', notebookId);
        }
    });

    juliaProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderrBuffer += text;
        console.log('[Julia stderr]', text.trim());

        // Wait for "Go to http://localhost" message which indicates HTTP server is ready
        if (!wsConnected && stderrBuffer.includes('Go to http://localhost')) {
            wsConnected = true;
            console.log('HTTP server is ready, connecting WebSocket...');
            setTimeout(() => connectWebSocket(port, notebookId), 1000);
        }
    });

    juliaProcess.on('exit', (code) => {
        console.log('Julia process exited with code', code);
        process.exit(code);
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        juliaProcess.kill();
        process.exit(0);
    });
}

function connectWebSocket(port, notebookId) {
    const clientId = uuidv4();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);

    ws.on('open', () => {
        console.log('WebSocket connected!');

        // Send connect message
        const connectMsg = {
            type: 'connect',
            client_id: clientId,
            request_id: uuidv4(),
            body: { notebook_id: notebookId },
            notebook_id: notebookId,
        };
        console.log('Sending connect message...');
        ws.send(encode(connectMsg));

        // After a short delay, request state reset
        setTimeout(() => {
            const resetMsg = {
                type: 'reset_shared_state',
                client_id: clientId,
                request_id: uuidv4(),
                body: {},
                notebook_id: notebookId,
            };
            console.log('Sending reset_shared_state...');
            ws.send(encode(resetMsg));
        }, 1000);
    });

    ws.on('message', (data) => {
        try {
            const msg = decode(data);
            console.log('\n[Message received]');
            console.log('Type:', msg.type);

            if (msg.type === '👋') {
                console.log('Got welcome message!');
                console.log('Options:', JSON.stringify(msg.message?.options_spec, null, 2)?.slice(0, 500));
            } else if (msg.type === 'notebook_diff') {
                const patches = msg.message?.patches;
                if (patches) {
                    console.log(`Got ${patches.length} patches`);
                    // Show first few patches
                    patches.slice(0, 3).forEach((p, i) => {
                        console.log(`  Patch ${i}: ${p.op} @ ${JSON.stringify(p.path)}`);
                    });
                    if (patches.length > 3) {
                        console.log(`  ... and ${patches.length - 3} more`);
                    }
                }
            } else {
                console.log('Message:', JSON.stringify(msg, null, 2).slice(0, 500));
            }
        } catch (e) {
            console.error('Failed to decode message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket closed');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
}

main().catch(console.error);
