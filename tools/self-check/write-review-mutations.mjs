// Self-contained offline mutation audit. Never edits the source checkout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const output=process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(),'tla-mutations-'));
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('output must be empty');
fs.mkdirSync(output,{recursive:true});
const relative='tools/collect-run-evidence.mjs';
const bytes=fs.readFileSync(path.join(root,relative));const source=bytes.toString('utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const recipes=[
 ['remove-write-audit','if (observationsComplete) issues.push(...implementationWriteIssues(state))','if (observationsComplete) void state'],
 ['remove-call-locator','callId: state.writeCalls.get(write.index)','callId: null'],
 ['only-latest-write',"return state.files.filter(event => event.kind === 'write' && IMPLEMENTATION_PATH.test(event.path))","return latestWrites(state.files.filter(event => event.kind === 'write' && IMPLEMENTATION_PATH.test(event.path)))"]
];
const dependencies=[relative,'tools/acceptance-summary.mjs','tools/ledger-from-run.mjs','tools/recompute-ledger.mjs','tests/lib/evidence-protocol-fixture.mjs','tests/v02-write-review-diagnostics.test.mjs'];
function run(args,cwd){const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:60000});return {exit:r.status,error:r.error?.message??null,stdout:r.stdout??'',stderr:r.stderr??''};}
const baseline=run(['tests/v02-write-review-diagnostics.test.mjs'],root);
if(baseline.exit!==0||baseline.error)throw Error('baseline must pass before mutations');
const results=[];
for(const [name,old,replacement] of recipes){
 if(source.split(old).length!==2)throw Error('recipe anchor must occur once: '+name);
 const dir=path.join(output,name);fs.mkdirSync(dir);
 for(const file of dependencies){const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}
 const mutated=source.replace(old,replacement);fs.writeFileSync(path.join(dir,relative),mutated);
 const patch={file:relative,old,replacement,occurrences:1,beforeSha256:hash(bytes),afterSha256:hash(Buffer.from(mutated))};
 fs.writeFileSync(path.join(dir,'patch.json'),JSON.stringify(patch,null,2));
 const syntaxArgs=['--check',relative],testArgs=['tests/v02-write-review-diagnostics.test.mjs'];
 const syntax=run(syntaxArgs,dir),test=run(testArgs,dir);
 fs.writeFileSync(path.join(dir,'test.log'),test.stdout+test.stderr);
 const killed=syntax.exit===0&&!syntax.error&&test.exit===1&&!test.error&&test.stderr.includes('AssertionError')&&!test.stderr.includes('ERR_MODULE_NOT_FOUND');
 results.push({name,patch,commands:[syntaxArgs,testArgs],syntaxExit:syntax.exit,testExit:test.exit,killed,logSha256:hash(Buffer.from(test.stdout+test.stderr))});
}
const report={schema:'tla.mutation-audit/v1',scope:'offline-synthetic',node:process.version,sourceSha256:hash(bytes),baselineExit:baseline.exit,sourceUnchanged:hash(fs.readFileSync(path.join(root,relative)))===hash(bytes),results};
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output,killed:results.filter(r=>r.killed).length,total:results.length,sourceUnchanged:report.sourceUnchanged}));
if(!report.sourceUnchanged||results.some(r=>!r.killed))process.exitCode=1;
