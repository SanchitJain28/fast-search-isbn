import test from 'node:test';
import assert from 'node:assert/strict';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const json = data => ({ok:true,status:200,json:async()=>data});
const pending = {id:'background-pending-123',isbn:'9781240126651',station:'Station-background'};
const saved = {...pending,seq:7,revision:0,statusType:'PACK',order:'ZB344'};
function clock() {
 let now=100000,id=0;const jobs=new Map();
 return {now:()=>now,setTimeout:(fn,ms)=>{const key=++id;jobs.set(key,{fn,at:now+ms});return key;},clearTimeout:key=>jobs.delete(key),
  advance:async ms=>{now+=ms;for(const [key,job] of [...jobs])if(job.at<=now){jobs.delete(key);job.fn();}await flush();},jobs};
}
async function make(t, fetch, existing = null) {
 globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};globalThis.EventSource=class{};
 const {PackingManager}=await import('../src/utils/sync.js');
 const data=new Map(existing?[['fast_search_pending_request',JSON.stringify(existing)]]:[]);
 const time=clock();const manager=new PackingManager({fetch,EventSource:class{},autoRecovery:true,now:time.now,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,
 storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}});
 t.after(()=>{manager.dispose();delete globalThis.localStorage;delete globalThis.EventSource;});
 return {manager,time,data};
}

test('background lookup confirms a saved scan while its POST and live feed are stalled',async t=>{
 let request,posts=0,lookups=0;
 const {manager,time,data}=await make(t,async(url,options)=>{
  if(url==='/api/scan'){posts++;request=JSON.parse(options.body);return new Promise(()=>{});}
  lookups++;assert.ok(url.endsWith(request.id));return json({scan:{...saved,...request}});
 });
 manager.ready=true;manager.connected=true;
 const waiting=manager.markPacked(saved.isbn);
 await time.advance(2000);
 const result=await waiting;
 assert.equal(result.id,request.id);assert.equal(posts,1);assert.equal(lookups,1);
 assert.equal(manager.busy,false);assert.equal(manager.pending,null);assert.equal(data.has('fast_search_pending_request'),false);
 assert.equal(manager.getPackedCount(saved.isbn),1);
 assert.equal(time.jobs.size,0);
});

test('a reloaded pending scan is recovered even before health, history or live events connect',async t=>{
 const ids=[];const {manager,time}=await make(t,async url=>{ids.push(url);return json({scan:saved});},pending);
 assert.equal(manager.connected,false);assert.equal(manager.ready,false);
 await time.advance(0);
 assert.equal(ids.length,1);assert.ok(ids[0].endsWith(pending.id));
 assert.equal(manager.pending,null);assert.equal(manager.lastConfirmed.id,pending.id);
});

test('background retries survive repeated outages without any heartbeat or operator click',async t=>{
 let online=false,lookups=0;
 const {manager,time,data}=await make(t,async url=>{assert.ok(url.endsWith(pending.id));lookups++;if(!online)throw Error('Offline');return json({scan:saved});},pending);
 manager.retryPending=async()=>{throw Error('Still offline');};
 await time.advance(0);assert.ok(manager.pending);assert.ok(time.jobs.size);
 await time.advance(4000);assert.ok(manager.pending);assert.equal(lookups,2);
 online=true;await time.advance(8000);
 assert.equal(lookups,3);assert.equal(manager.pending,null);assert.equal(manager.lastConfirmed.id,pending.id);
 assert.equal(data.has('fast_search_pending_request'),false);assert.equal(time.jobs.size,0);
});

test('a single failed health probe does not disable a recently reachable scanner',async t=>{
 const {manager,time}=await make(t,async()=>{throw Error('Probe failed');});
 manager.updateHealth({ready:true,mirror:{},userCount:2});
 await manager.health();assert.equal(manager.connected,true);
 await time.advance(16000);await manager.health();assert.equal(manager.connected,false);
 manager.updateHealth({ready:true,mirror:{},userCount:2});assert.equal(manager.connected,true);
});

test('another scan cannot replace an in-flight request during confirmation cleanup',async t=>{
 const {manager,data}=await make(t,async()=>json({}));manager.busy=true;
 await assert.rejects(manager.markPacked(saved.isbn),/already being saved/);
 assert.equal(manager.pending,null);assert.equal(data.has('fast_search_pending_request'),false);
});
