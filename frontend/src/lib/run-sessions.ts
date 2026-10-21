import { updateRunEvents } from './run-progress.js';

/** Each event keeps its run and chat identity, including events from hidden chats. */
export class RunSessions {
  readonly states=new Map<string,RunState>();
  readonly modes=new Map<string,ExecutionMode>();
  readonly owners = new Map<string,string>();
  readonly latest = new Map<string,string>();
  readonly events = new Map<string,RunEvent[]>();
  register(runId:string,chatId:string,mode?:ExecutionMode):void {if(mode)this.modes.set(runId,mode);this.owners.set(runId,chatId);this.latest.set(chatId,runId);}
  record(event:RunEvent):void {
    if(event.type==='run_registered')this.register(event.runId,event.chatId,event.mode);
    if(event.type==="run_state")this.states.set(event.runId,event.state);
    const runId=(event as {runId?:string}).runId;
    if(!runId)return;
    // Draft text is restored from the backend snapshot. Do not retain every token twice.
    if(event.type==='assistant_message_chunk')return;
    const previous=this.events.get(runId)??[];
    this.events.set(runId,updateRunEvents(previous,event).slice(-500));
  }
  belongsTo(runId:string,chatId:string|null):boolean{return !!chatId&&this.owners.get(runId)===chatId;}
}
