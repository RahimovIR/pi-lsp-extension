// Deterministic protocol fixture; it does not implement a real C# compiler.
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver-protocol/node';
import { writeFileSync } from 'node:fs';
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const docs = new Map(), events = [];
let root, folders, options = {};
const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } };
const diagnostic = (code, severity = 1) => ({ range, severity, code, message: `fixture ${code}` });
const report = uri => ({ kind: 'full', items: docs.get(uri)?.text.includes('__undefined') ? [diagnostic('CS0103')] : [] });
connection.onRequest('initialize', async params => {
  root = params.rootUri; folders = params.workspaceFolders;
  if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
  if (process.env.INIT_DELAY) await new Promise(r => setTimeout(r, Number(process.env.INIT_DELAY)));
  return { capabilities: { textDocumentSync: 1, definitionProvider: true, renameProvider: true,
    ...(process.env.NO_PULL ? {} : { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true } }) } };
});
connection.onNotification('textDocument/didOpen', p => {
  docs.set(p.textDocument.uri, p.textDocument); events.push({ method: 'open', version: p.textDocument.version });
  connection.sendNotification('textDocument/publishDiagnostics', { uri: p.textDocument.uri, diagnostics: [diagnostic('CACHED', 2)] });
});
connection.onNotification('textDocument/didChange', p => {
  const doc = docs.get(p.textDocument.uri);
  if (doc) { doc.text = p.contentChanges[0].text; doc.version = p.textDocument.version; }
  events.push({ method: 'change', version: p.textDocument.version, wasOpen: !!doc });
});
connection.onNotification('textDocument/didClose', p => { docs.delete(p.textDocument.uri); events.push({ method: 'close' }); });
connection.onRequest('textDocument/diagnostic', p => {
  if (options.pull === 'invalid') return null;
  if (options.pull === 'unchanged') return { kind: 'unchanged', resultId: 'unexpected' };
  if (options.pull === 'error') throw new Error('fixture diagnostic failure');
  return report(p.textDocument.uri);
});
connection.onRequest('workspace/diagnostic', () => ({ items: [
  ...[...docs.keys()].map(uri => ({ uri, version: null, ...report(uri) })),
  { uri: new URL('unopened.cs', root + '/').href, version: null, kind: 'full', items: [diagnostic('WORKSPACE', 2)] },
] }));
connection.onRequest('textDocument/rename', p => options.rename ?? { changes: { [p.textDocument.uri]: [{ range, newText: 'Elevation' }] } });
connection.onRequest('textDocument/definition', () => options.definition ?? [{ uri: 'csharp:/fixture/decompiled/Point.cs', range }]);
connection.onRequest('csharp/metadata', () => options.metadata ?? { source: 'public struct Point { public double X; }' });
connection.onRequest('test/set', p => { options = p; return null; });
connection.onRequest('test/state', () => ({ pid: process.pid, root, folders, docs: [...docs.values()], events }));
connection.onRequest('test/crash', () => { setTimeout(() => process.exit(23), 10); return null; });
connection.onRequest('shutdown', () => process.env.IGNORE_SHUTDOWN ? new Promise(() => {}) : null);
connection.onNotification('exit', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
connection.listen();
