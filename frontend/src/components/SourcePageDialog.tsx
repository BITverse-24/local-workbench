import { useEffect, useState } from 'react';

import { parsePageRange } from '../../../backend/src/shared/source-pages.js';

export default function SourcePageDialog({selection,onSelect,onCancel}:{selection:SourcePageSelection|null;onSelect:(pages:number[])=>Promise<void>;onCancel:()=>void}) {
  const [range,setRange]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{setRange('');setError('');setBusy(false);},[selection?.selectionId]);
  if(!selection)return null;
  const submit=async()=>{
    try{
      const pages=parsePageRange(range,selection.pageCount);
      if(pages.some(page=>selection.pageViewCounts[page-1]>selection.maxViews))throw new Error('A selected page exceeds the detail limit. Supply a smaller source or region for that page.');
      const views=pages.reduce((n,page)=>n+selection.pageViewCounts[page-1],0);
      if(pages.length>selection.maxPages||views>selection.maxViews)throw new Error('This selection exceeds the inspection limit. Choose fewer pages.');
      setBusy(true);setError('');await onSelect(pages);
    }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5">
    <section role="dialog" aria-modal="true" aria-labelledby="source-page-title" className="w-full max-w-lg rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-6 text-[var(--text-primary)] shadow-xl">
      <h2 id="source-page-title" className="text-lg font-semibold">Select pages to inspect</h2>
      <p className="mt-3 break-words">{selection.filename} · {selection.pageCount} pages</p>
      <p className="mt-2 text-sm">{selection.reason} Select up to {selection.maxPages} pages. Detailed views must also fit the available run budget. Other pages will be excluded from this review.</p>
      <label className="mt-4 block text-sm">Page range<input autoFocus value={range} onChange={event=>setRange(event.target.value)} placeholder="1, 3-5" className="mt-2 block w-full rounded border border-[var(--border-subtle)] bg-transparent p-2" /></label>
      {error&&<p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-5 flex justify-end gap-3"><button onClick={onCancel} disabled={busy}>Cancel review</button><button className="rounded bg-[var(--accent)] px-4 py-2" disabled={busy} onClick={()=>void submit()}>{busy?'Starting inspection…':'Inspect selected pages'}</button></div>
    </section>
  </div>;
}
