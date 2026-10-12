// Test-only renderer bridge. No model or workspace operations run.
const {contextBridge} = require('electron');
const id='00000000-0000-4000-8000-000000000001';
let chatListener, runListener, workspaceListener; let suggestionDelay=0; let activeChat=id, hold=false, lastStart=null;
const longText='A long response with source details. '.repeat(70)+'\n\n| Source | Status | Description |\n| --- | --- | --- |\n| src/very_long_identifier_with_many_characters_and_another_component.ts | Read | '+'long_cell_'.repeat(90)+' |\n\n```ts\n'+('const item = "source";\n'.repeat(15))+'```';
const rows=[{id:'long-user',role:'user',content:'Review the workspace sources and list the findings.'},{id:'long-assistant',role:'assistant',content:longText}];
let ws={root:'/test/workspace',registeredAt:'2026-10-12T00:00:00Z'};
const entries=[{name:'src',type:'directory',size:0},{name:'src/input.ts',type:'file',size:20},{name:'source files/試験.ts',type:'file',size:20}];
contextBridge.exposeInMainWorld('workbench',{
 getOnboardingStatus:async()=>({completed:true}),getChatHistory:async()=>({chats:[{id,title:'Inspect saved source files',updated_at:new Date().toISOString()}]}),
 getSetting:async()=>({value:null}),setSetting:async()=>{},getHealth:async()=>[],getExecutionCapabilities:async()=>null,
 getCurrentWorkspace:async()=>ws,listWorkspaceDir:async()=>({result:entries}),kbListDocs:async()=>[],kbStats:async()=>({documentCount:0,chunkCount:0}),
 getMessages:async()=>({messages:rows}),getRunSnapshot:async()=>undefined,
 createChat:async()=>({chatId:id}),sendMessage:async(cid,role,content)=>{activeChat=cid;return {messageId:'user-'+Date.now(),seq:0,chatTitle:{type:'chat_title_changed',chatId:cid,title:'Inspect selected workspace file',revision:1}}},
 startRun:async(input)=>{lastStart=input;setTimeout(()=>{
  runListener?.({type:'run_registered',runId:input.runId,chatId:input.chatId,mode:input.mode});
  runListener?.({type:'run_state',runId:input.runId,state:'acting'});
  runListener?.({type:'assistant_message_chunk',runId:input.runId,messageId:'streamed',modelId:'primary-model',delta:'Reading source files.\n\n'+longText});
  if(!hold)setTimeout(()=>runListener?.({type:'run_state',runId:input.runId,state:'completed'}),100);
 },50);return {runId:input.runId}},
 suggestWorkspacePaths:async({query})=>{const delay=suggestionDelay;suggestionDelay=0;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return {entries:entries.filter(e=>e.name.toLowerCase().includes(query.toLowerCase())),truncated:false}},
 onRunEvent:(fn)=>{runListener=fn;return()=>{runListener=null}},onChatEvent:(fn)=>{chatListener=fn;return()=>{chatListener=null}},onWorkspaceEvent:(fn)=>{workspaceListener=fn;return()=>{workspaceListener=null}},
 renameChat:async()=>{},archiveChat:async()=>{},resetOnboarding:async()=>({ok:true}),cancelRun:async()=>{},
});
contextBridge.exposeInMainWorld('uxFixture',{hold:(value)=>{hold=value},finish:()=>runListener?.({type:'run_state',runId:lastStart.runId,state:'completed'}),delaySuggestions:(ms)=>{suggestionDelay=ms},workspace:(value)=>{ws=value;workspaceListener?.(value?{type:'workspace_registered',workspace:value}:{type:'workspace_deregistered'})},lastStart:()=>lastStart,title:(title)=>chatListener?.({type:'chat_title_changed',chatId:activeChat,title,revision:2})});
