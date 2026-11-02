import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LspManager } from '../src/lsp-manager.js';
import { FileSync } from '../src/file-sync.js';
import { createRenameTool, formatWorkspaceEdit } from '../src/tools/rename.js';
import { createDefinitionTool } from '../src/tools/definition.js';
import { createDiagnosticsTool } from '../src/tools/diagnostics.js';
import lspExtension from '../src/index.js';
const fixture = fileURLToPath(new URL('./fixtures/semantic-lsp.mjs', import.meta.url));
const config = (env?: Record<string,string>) => ({ command: process.execPath, args: [fixture], env });
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');
const run = (tool: { execute: Function }, params: unknown): Promise<any> => tool.execute('t', params, undefined, undefined, {});
async function until(predicate: () => unknown) { const end = Date.now()+8000; while (!predicate()) { assert(Date.now()<end, 'condition timed out'); await sleep(10); } }
const alive = (pid: number) => { try { process.kill(pid,0); return true; } catch { return false; } };
async function setup(env?: Record<string,string>) {
  const dir=mkdtempSync(join(tmpdir(),'pi-csharp-')); writeFileSync(join(dir,'a.cs'),'WithZ\n');
  const manager=new LspManager(dir,{csharp:config(env)});
  await manager.getClientForLanguage('csharp'); await until(()=>manager.getRunningClient('csharp'));
  const client=manager.getRunningClient('csharp')!;
  const sync=new FileSync(manager); await sync.handleFileRead('a.cs');
  return {dir,manager,client,sync,close:async()=>{await manager.shutdownAll();rmSync(dir,{recursive:true,force:true});}};
}

test('rename renders exclusive end ranges, escaped text, versions and resource operations',()=>{
  const uri=pathToFileURL(join(tmpdir(),'a.cs')).href;
  const edit={range:{start:{line:0,character:4},end:{line:1,character:2}},newText:'a\n"b"'};
  const formatted=formatWorkspaceEdit({documentChanges:[{textDocument:{uri,version:7},edits:[edit]},{kind:'create',uri:uri+'.new'}]},tmpdir());
  assert.match(formatted.summary,/1:5-2:3 → "a\\n\\"b\\""/);
  assert.match(formatted.summary,/version: 7/);assert.match(formatted.summary,/Resource operation:.*create/);
  assert.equal(formatted.resourceOperations,1);assert.equal(formatted.editCount,1);
});

test('rename returns the unmodified raw WorkspaceEdit, without writing the source',{timeout:15000},async()=>{
  const s=await setup();try{
    const r=await run(createRenameTool(s.manager),{path:'a.cs',line:1,character:1,newName:'WithElevation'});
    assert.match(text(r),/1:5-1:6 → "Elevation"/);assert.equal(r.details.editCount,1);
    assert.equal(r.details.workspaceEdit!.changes![s.manager.getFileUri('a.cs')][0].range.end.character,5);
    assert.equal(readFileSync(join(s.dir,'a.cs'),'utf8'),'WithZ\n');
  }finally{await s.close();}
});

test('truncated rename preserves the complete raw plan in a readable temporary file',{timeout:15000},async()=>{
  const s=await setup();let output:string|undefined;
  try{
    const plan={changes:{[s.manager.getFileUri('a.cs')]:[{range:{start:{line:0,character:4},end:{line:0,character:5}},newText:'x'.repeat(70000)}]}};
    await s.client.sendRequest('test/set',{rename:plan});
    const r=await run(createRenameTool(s.manager),{path:'a.cs',line:1,character:1,newName:'Long'});
    output=r.details.fullOutputPath;assert(output);assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),plan);
    assert.match(text(r),/Truncated/);assert.deepEqual(r.details.workspaceEdit,plan);
  }finally{if(output)rmSync(dirname(output),{recursive:true,force:true});await s.close();}
});

test('fresh document/workspace diagnostics are distinct from cache, and severity filtering retains total counts',{timeout:15000},async()=>{
  const s=await setup();try{
    await s.client.sendRequest('test/state',{});
    const tool=createDiagnosticsTool(s.manager);
    const cached=await run(tool,{path:'*'});assert.match(text(cached),/Cached push/);assert.equal(cached.details.count,1);
    const fresh=await run(tool,{path:'*',mode:'pull'});assert.match(text(fresh),/WORKSPACE/);assert(!text(fresh).includes('CACHED'));
    assert.equal(fresh.details.complete,true);
    const filtered=await run(tool,{path:'*',mode:'pull',severity:'error'});
    assert.equal(filtered.details.count,0);assert.equal(filtered.details.totalCount,1);
    const file=await run(tool,{path:'a.cs',mode:'pull'});assert.equal(file.details.count,0);
  }finally{await s.close();}
});

test('unsupported, incomplete and failed pull requests are errors, never a clean result',{timeout:20000},async()=>{
  for(const mode of ['unsupported','unchanged','invalid','error']){
    const s=await setup(mode==='unsupported'?{NO_PULL:'1'}:undefined);
    try{
      if(mode!=='unsupported')await s.client.sendRequest('test/set',{pull:mode});
      const r=await run(createDiagnosticsTool(s.manager),{path:'a.cs',mode:'pull'});
      assert('isError'in r&&r.isError===true,mode);assert.equal(r.details.complete,false);assert.match(text(r),/failed/);
    }finally{await s.close();}
  }
});

test('metadata is opt-in, supports Location and LocationLink, and validates the server response',{timeout:15000},async()=>{
  const s=await setup();try{
    const tool=createDefinitionTool(s.manager),args={path:'a.cs',line:1,character:1};
    const normal=await run(tool,args);assert(!text(normal).includes('public struct'));
    const result=await run(tool,{...args,includeMetadata:true});assert.match(text(result),/public struct Point/);assert.equal(result.details.metadataCount,1);
    const range={start:{line:0,character:0},end:{line:0,character:5}};
    await s.client.sendRequest('test/set',{definition:[{targetUri:'csharp:/fixture.cs',targetRange:range,targetSelectionRange:range}]});
    const link=await run(tool,{...args,includeMetadata:true});assert.equal(link.details.metadataCount,1);
    await s.client.sendRequest('test/set',{metadata:{source:null}});
    const bad=await run(tool,{...args,includeMetadata:true});assert('isError'in bad&&bad.isError===true);
  }finally{await s.close();}
});

test('metadata truncation points to the complete source instead of silently losing it',{timeout:15000},async()=>{
  const s=await setup();let output:string|undefined;
  try{
    const source='// source\n'.repeat(3000);await s.client.sendRequest('test/set',{metadata:{source}});
    const r=await run(createDefinitionTool(s.manager),{path:'a.cs',line:1,character:1,includeMetadata:true});
    output=r.details.fullOutputPath;assert(output);assert(readFileSync(output,'utf8').endsWith(source));assert.match(text(r),/Output truncated/);
  }finally{if(output)rmSync(dirname(output),{recursive:true,force:true});await s.close();}
});

test('file sync updates edited buffers, refreshes externally changed reads, and reopens after restart',{timeout:20000},async()=>{
  const s=await setup();try{
    writeFileSync(join(s.dir,'a.cs'),'__undefined\n');await s.sync.handleFileWrite('a.cs');
    assert.equal((await s.client.pullDiagnostics(s.manager.getFileUri('a.cs'))).values().next().value![0].code,'CS0103');
    writeFileSync(join(s.dir,'a.cs'),'WithZ\n');await s.sync.handleFileRead('a.cs');
    assert.equal((await s.client.pullDiagnostics(s.manager.getFileUri('a.cs'))).values().next().value!.length,0);
    let state:any=await s.client.sendRequest('test/state',{});assert.deepEqual(state.events.map((e:any)=>[e.method,e.version]),[['open',1],['change',2],['change',3]]);
    const old=state.pid;await s.manager.restartServer('csharp');assert.equal(alive(old),false);
    await s.sync.handleFileWrite('a.cs');
    state=await s.manager.getRunningClient('csharp')!.sendRequest('test/state',{});
    assert.equal(state.events[0].method,'open');assert.equal(state.docs[0].text,'WithZ\n');
  }finally{await s.close();}
});

test('worktree changes replace the old server; identical workspace folders reuse the connection',{timeout:20000},async()=>{
  const s=await setup(),other=mkdtempSync(join(tmpdir(),'pi-csharp-other-'));
  const provider=(root:string)=>({type:'test',workspaceRoot:root,stateDir:null,getWorkspaceFolders:()=>[{uri:pathToFileURL(root).href,name:'test'}],ensureReady:async()=>true,getStatusText:()=>'',shutdown(){}});
  try{
    s.manager.setWorkspaceProvider(provider(s.dir));await s.manager.getClientForLanguage('csharp');await until(()=>s.manager.getRunningClient('csharp'));
    const first:any=await s.manager.getRunningClient('csharp')!.sendRequest('test/state',{});
    s.manager.setWorkspaceProvider(provider(s.dir));const same=await s.manager.getClientForLanguage('csharp');
    assert.equal((await same!.sendRequest<any>('test/state',{})).pid,first.pid);
    s.manager.setWorkspaceProvider(provider(other));assert.equal(s.manager.getRunningClient('csharp'),null);
    await s.manager.getClientForLanguage('csharp');await until(()=>s.manager.getRunningClient('csharp'));
    const second:any=await s.manager.getRunningClient('csharp')!.sendRequest('test/state',{});
    assert.notEqual(second.pid,first.pid);assert.equal(alive(first.pid),false);assert.equal(second.folders[0].uri,pathToFileURL(other).href);
  }finally{await s.close();rmSync(other,{recursive:true,force:true});}
});

test('shutdown during initialize kills the starting subprocess and cannot restart it',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-csharp-start-')),pidFile=join(dir,'pid');
  const mgr=new LspManager(dir,{csharp:config({INIT_DELAY:'30000',PID_FILE:pidFile})});
  try{
    await mgr.getClientForLanguage('csharp');await until(()=>existsSync(pidFile));const pid=Number(readFileSync(pidFile,'utf8'));
    await mgr.shutdownAll();assert.equal(alive(pid),false);assert.equal(await mgr.getClientForLanguage('csharp'),null);
  }finally{await mgr.shutdownAll();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown cancels a pending crash restart and releases the owned process',{timeout:15000},async()=>{
  const s=await setup();try{
    const state:any=await s.client.sendRequest('test/state',{});await s.client.sendRequest('test/crash',{});
    await until(()=>!s.manager.getRunningClient('csharp'));await s.manager.shutdownAll();
    await sleep(1100);assert.equal(alive(state.pid),false);assert.equal(s.manager.getStatus().some(s=>s.running),false);
  }finally{await s.close();}
});

test('extension factory does not install a process-wide uncaughtException suppressor',()=>{
  const before=process.listeners('uncaughtException');
  lspExtension({events:{on(){}},registerTool(){},registerCommand(){},on(){}} as any);
  assert.deepEqual(process.listeners('uncaughtException'),before);
});
