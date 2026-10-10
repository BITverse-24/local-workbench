import { getDb } from '../persistence/db.js';
import { addMessage } from '../persistence/messages.js';
import { getState, transition } from './store.js';
/** Keep interrupted text and evidence. Never grant authority or replay work on boot. */
export function recoverInterruptedModeRuns():number {
  const db=getDb();
  const rows=db.prepare("SELECT r.id,r.chat_id FROM runs r JOIN run_mode_details m ON m.run_id=r.id WHERE r.state IN ('created','classifying','planning','acting','awaiting_confirmation') OR (r.state='partial' AND EXISTS (SELECT 1 FROM run_drafts d WHERE d.run_id=r.id AND NOT EXISTS (SELECT 1 FROM messages msg WHERE msg.id=d.message_id)))").all() as Array<{id:string;chat_id:string}>;
  for(const row of rows){
    const draft=db.prepare('SELECT message_id,model_id,text FROM run_drafts WHERE run_id=?').get(row.id) as {message_id:string;model_id:string;text:string}|undefined;
    if(draft?.text&&!db.prepare('SELECT id FROM messages WHERE id=?').get(draft.message_id))addMessage({id:draft.message_id,chat_id:row.chat_id,run_id:row.id,role:'assistant',model_id:draft.model_id,content:draft.text});
    if(!['completed','partial','failed','cancelled','limit_exceeded'].includes(getState(row.id)))transition(row.id,'partial');
    db.prepare("UPDATE run_mode_details SET metrics_json=json_set(metrics_json,'$.outcome','partial','$.queued',json('false'),'$.interrupted',json('true')) WHERE run_id=?").run(row.id);
  }
  db.prepare("UPDATE confirmations SET outcome='expired',decided_at=? WHERE outcome IS NULL").run(new Date().toISOString());
  return rows.length;
}
