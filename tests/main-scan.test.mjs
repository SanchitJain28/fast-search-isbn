import test from 'node:test';
import assert from 'node:assert/strict';
import {PackingStore} from '../server/store.js';
import {SheetMirror, mainScanValues} from '../server/sheets.js';

function fixture({ fail = false, occupied, columns = 10, rowCount = 20000 } = {}) {
  const catalog=[{ISBN13:'9781234567890',Order:'317',Title:'Book'}];
  const store=new PackingStore(':memory:',catalog);store.initializeEmpty();
  const historic=store.scan({id:'historical-one',isbn:catalog[0].ISBN13});store.acknowledge([historic.seq]);
  const duplicate=store.scan({id:'new-duplicate',isbn:catalog[0].ISBN13});
  store.setMeta('mirrorTarget',JSON.stringify(['test','Scan']));
  store.setMeta('mainScanLayout',JSON.stringify({spreadsheetId:'test',tab:'Scan',sheetId:42,startSeq:2,startRow:14300}));
  const cells=new Map();if(occupied)cells.set(14300,occupied);const writes=[];let failOnce=fail;
  const client={spreadsheets:{
    get:async()=>({data:{sheets:[{properties:{sheetId:42,title:'Scan',gridProperties:{rowCount,columnCount:columns}}}]}}),
    batchUpdate:async()=>{rowCount=15300;},
    values:{
      get:async({range})=>{const match=range.match(/A(\d+):J(\d+)/);return {data:{values:Array.from({length:Number(match[2])-Number(match[1])+1},(_,i)=>cells.get(Number(match[1])+i)||[])}};},
      batchUpdate:async({requestBody})=>{writes.push(requestBody);for(const r of requestBody.data){const row=Number(r.range.match(/!A(\d+)/)[1]);cells.set(row,r.values[0]);}if(failOnce){failOnce=false;throw Error('Response lost after Google saved values');}}
    }
  }};
  const mirror=()=>new SheetMirror(store,{client,spreadsheetId:'test',tab:'Scan',enabled:true});
  return {store,duplicate,writes,cells,mirror};
}

test('main Scan preserves row layout, writes duplicate once and recovers an ambiguous response',async()=>{
  const f=fixture({fail:true});let mirror=f.mirror();
  await mirror.flush();assert.equal(f.store.stats().pending,1);assert.match(mirror.lastError,/Response lost/);
  assert.equal(f.writes[0].data[0].range,"'Scan'!A14300:J14300");
  assert.equal(f.writes[0].data.length,1);assert.deepEqual(f.cells.get(14300),mainScanValues(f.duplicate));
  mirror=f.mirror();await mirror.flush();assert.equal(f.store.stats().pending,0);
  assert.equal(f.cells.size,1);assert.equal(mirror.status().tab,'Scan');f.store.close();
});
test('main Scan refuses to overwrite another entry or replay historic rows',async()=>{
  const f=fixture({occupied:['other-barcode','327','Other book','PACK']});
  let mirror=f.mirror();await mirror.flush();assert.match(mirror.lastError,/contains another entry/);assert.equal(f.writes.length,0);
  f.store.db.prepare('UPDATE scans SET synced=0 WHERE seq=1').run();
  mirror=f.mirror();await mirror.flush();assert.match(mirror.lastError,/Historical Scan rows/);assert.equal(f.writes.length,0);f.store.close();
});
test('main Scan grows its grid and maps subsequent server sequences to successive rows',async()=>{
  const f=fixture({rowCount:100});
  const unknown=f.store.scan({id:'new-unknown-barcode',isbn:'1234567890123'});
  await f.mirror().flush();assert.equal(f.store.stats().pending,0);
  assert.equal(f.writes[0].data[1].range,"'Scan'!A14301:J14301");
  assert.equal(f.cells.get(14301)[1],'NOT FOUND');assert.equal(f.cells.get(14301)[5],unknown.id);f.store.close();
});
test('main Scan refuses an unprepared tab or changed destination',async()=>{
  const f=fixture({columns:4});let mirror=f.mirror();await mirror.flush();assert.match(mirror.lastError,/tracking columns/);
  f.store.setMeta('mirrorTarget',JSON.stringify(['other','Scan']));mirror=f.mirror();await mirror.flush();assert.match(mirror.lastError,/destination changed/);f.store.close();
});
