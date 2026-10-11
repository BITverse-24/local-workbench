const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const asar=require('@electron/asar');
const app=path.resolve(process.argv[2]);
const archive=path.join(app,'Contents/Resources/app.asar');
const files=asar.listPackage(archive);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const packagedMain=asar.extractFile(archive,'electron/dist-electron/main.cjs');
const result={app,files:files.length,mainMatchesBuiltBundle:hash(packagedMain)===hash(fs.readFileSync('electron/dist-electron/main.cjs')),appMainSha256:hash(packagedMain),unwantedFiles:files.filter(name=>/^\/(?:data|tests|docs|demo)(?:\/|$)|\/\.env(?:\.|$)/.test(name))};
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-package-db-'));
const script=path.join(temporary,'sqlite.cjs');
fs.writeFileSync(script,`
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const packaged=createRequire(${JSON.stringify(path.join(archive,'electron/dist-electron/main.cjs'))});
const DB=packaged('better-sqlite3');
const db=new DB(${JSON.stringify(path.join(temporary,'test.db'))});
db.exec(fs.readFileSync(${JSON.stringify(path.join(app,'Contents/Resources/backend/schema.sql'))},'utf8'));
console.log(JSON.stringify({sqliteVersion:db.prepare('select sqlite_version() as version').get().version,integrity:db.pragma('integrity_check',{simple:true}),foreignKeys:db.pragma('foreign_key_check'),tables:db.prepare("select name from sqlite_master where type='table' order by name").all().map(row=>row.name)}));db.close();
`);
try{
 const run=spawnSync(path.join(app,'Contents/MacOS/Sovereign Workbench'),[script],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 if(run.status!==0)throw new Error(run.stderr||run.stdout);
 result.sqlite=JSON.parse(run.stdout.trim());
 console.log(JSON.stringify(result,null,2));
 if(!result.mainMatchesBuiltBundle||result.unwantedFiles.length||result.sqlite.integrity!=='ok'||result.sqlite.foreignKeys.length)process.exitCode=1;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
