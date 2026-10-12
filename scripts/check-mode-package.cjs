// Verify the independent readers with dependencies from the packaged app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const app = path.resolve(process.argv[2] || 'release/0.1.0/mac-arm64/Local Workbench.app');
const packagedMain = path.join(app, 'Contents/Resources/app.asar/electron/dist-electron/main.cjs');
if (!fs.existsSync(path.join(app, 'Contents/Resources/app.asar'))) throw new Error('Build the macOS directory package first.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-package-check-'));
const reader = path.join(temporary, 'reader.cjs');
require('esbuild').buildSync({ entryPoints: ['backend/src/main/tools/file-worker.ts'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: reader, define: { __filename: JSON.stringify(packagedMain) } });
const check = path.join(temporary, 'check.cjs');
fs.writeFileSync(check, `
const path=require('node:path'),fs=require('node:fs'),{createRequire}=require('node:module');
const packaged=createRequire(${JSON.stringify(packagedMain)});
const {parseFileIndependently}=require('./reader.cjs');
(async()=>{
 const pdf=await parseFileIndependently(${JSON.stringify(path.resolve('demo/flow_a/scenario-1/inspection-report-E201-annotated.pdf'))},'pdf');
 if(pdf.pages.length!==2||!pdf.text.includes('E-201'))throw new Error('PDF content missing');
 const {Document,Paragraph,Packer}=packaged('docx');
 const word=path.join(__dirname,'report.docx');
 fs.writeFileSync(word,await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Required package source evidence.')]}]})));
 const parsedWord=await parseFileIndependently(word,'docx');
 if(!parsedWord.text.includes('Required package source evidence.'))throw new Error('DOCX content missing');
 const ExcelJS=packaged('exceljs'),workbook=new ExcelJS.Workbook();
 const sheet=workbook.addWorksheet('Values');sheet.addRow(['Name','Number','Enabled']);sheet.addRow(['Alpha',7,true]);
 const excel=path.join(__dirname,'table.xlsx');await workbook.xlsx.writeFile(excel);
 const parsedExcel=await parseFileIndependently(excel,'xlsx');
 if(parsedExcel.sheets[0]!=='Values'||parsedExcel.rowCount!==1||parsedExcel.rows[1][1]!==7||parsedExcel.rows[1][2]!==true)throw new Error('XLSX structure or value types changed');
 console.log('Packaged PDF, DOCX, XLSX readers and native canvas passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
try {
  const binary = path.join(app, 'Contents/MacOS/Local Workbench');
  const result = spawnSync(binary, [check], {stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
