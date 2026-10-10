const path=require('node:path');const fs=require('node:fs');const {spawnSync}=require('node:child_process');
const output=path.resolve(process.argv[2]||'tests/.runtime/benchmarks/modes.json');fs.mkdirSync(path.dirname(output),{recursive:true});
const bundled=path.resolve('tests/.runtime/benchmarks/modes.cjs');
require('esbuild').buildSync({entryPoints:['tests/benchmark/modes.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundled,packages:'external'});
const result=spawnSync(require('electron'),[bundled,output],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});process.exitCode=result.status??1;
