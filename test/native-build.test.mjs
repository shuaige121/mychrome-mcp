/* Exercise the real build script with a fake compiler in a temporary checkout. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const fail of ['cgevent','chromectl',null]) test(`native build ${fail ? `failure at ${fail} preserves both binaries` : 'publishes only after both compiles succeed'}`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mychrome-native-build-'));
  try {
    for (const name of ['src','bin','scripts']) fs.mkdirSync(path.join(root,name));
    const script=path.join(root,'scripts/build-native.sh');
    fs.copyFileSync(new URL('../scripts/build-native.sh',import.meta.url),script);
    for (const name of ['helper.swift','chromectl.swift','native-chrome.swift']) fs.writeFileSync(path.join(root,'src',name),`fixture ${name}`);
    for (const name of ['cgevent','chromectl','cbmenu']) fs.writeFileSync(path.join(root,'bin',name),`old ${name}`);
    const compiler=path.join(root,'compiler.cjs'), calls=path.join(root,'calls.jsonl');
    fs.writeFileSync(compiler,`#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); const out=args[args.indexOf('-o')+1]; const name=out.includes('/cgevent/')?'cgevent':'chromectl'; fs.appendFileSync(process.env.BUILD_CALLS,JSON.stringify({args,name})+'\\n'); if(process.env.BUILD_FAIL===name) process.exit(73); fs.writeFileSync(out,'new '+name);\n`);
    fs.chmodSync(compiler,0o755);
    const r=spawnSync('/bin/sh',[script],{env:{...process.env,MYCHROME_SWIFTC:compiler,BUILD_CALLS:calls,BUILD_FAIL:fail||''},encoding:'utf8'});
    assert.equal(r.status,fail?73:0,r.stderr);
    for(const name of ['cgevent','chromectl']) assert.equal(fs.readFileSync(path.join(root,'bin',name),'utf8'),`${fail?'old':'new'} ${name}`);
    assert.equal(fs.readFileSync(path.join(root,'bin/cbmenu'),'utf8'),'old cbmenu');
    const actual=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(actual.length,fail==='cgevent'?1:2);
    for(const {args,name} of actual){
      assert.equal(args[args.indexOf('-target')+1],'arm64-apple-macos13');
      assert.ok(args.includes(path.join(root,'src/native-chrome.swift')));
      assert.ok(args.some(x=>x.endsWith(`/${name}/main.swift`)));
    }
    assert.deepEqual(fs.readdirSync(path.join(root,'bin')).sort(),['cbmenu','cgevent','chromectl']);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
