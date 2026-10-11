import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {writeFileSync} from 'node:fs';
import ConfirmationModal from '../../../frontend/src/components/ConfirmationModal';
const html=renderToStaticMarkup(<ConfirmationModal open action={{actionId:'probe',runId:'audit-run',kind:'uncontained_python',
 prompt:'Approve Python without OS isolation? Filesystem and network isolation are not enforced.',preview:'print(1)',
 createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()}} runState="awaiting_confirmation" onApprove={()=>{}} onReject={()=>{}} onClose={()=>{}} />);
const result={showsWrongExcelBadge:html.includes('Excel spreadsheet generation'),showsGenericGenerateButton:html.includes('Approve &amp; generate'),
 warningPresent:html.includes('Filesystem and network isolation are not enforced.'),claimsSandboxed:html.includes('Sandboxed execution')};
writeFileSync('/tmp/workbench-ship-approval-render.html',html);writeFileSync('/tmp/workbench-ship-approval-render.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
