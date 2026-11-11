import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PackingStore} from '../server/store.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const layout=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const catalog=JSON.parse(fs.readFileSync(path.join(root,'public/master.json'),'utf8'));
const store=new PackingStore(process.env.PACKING_DB||path.join(root,'data/packing.sqlite'),catalog);
try{
 if(!store.ready)throw Error('Catalog/database must be reconciled before switching reporting');
 const imports=store.list().filter(scan=>scan.station==='Imported history').sort((a,b)=>a.seq-b.seq);
 const hash=createHash('sha256').update(JSON.stringify(imports.map(s=>[s.id,s.isbn,s.order,s.statusType]))).digest('hex');
 if(hash!==layout.historyHash||imports.length!==layout.historicalCount||imports.at(-1)?.seq+1!==layout.startSeq||layout.tab!=='Scan'||layout.startRow<4)throw Error('Prepared Scan layout does not match the historical database');
 if(store.getMeta('mainScanLayout'))throw Error('Main Scan reporting is already configured; do not re-queue it automatically');
 const oldTarget=store.getMeta('mirrorTarget');
 if(JSON.parse(oldTarget||'null')?.[0]!==layout.spreadsheetId)throw Error('The source workbook differs from the configured mirror');
 const {backupFile,...savedLayout}=layout;
 store.transaction(()=>{
  store.setMeta('preMainScanMirrorTarget',oldTarget);
  store.setMeta('mainScanLayout',JSON.stringify(savedLayout));
  store.setMeta('mirrorTarget',JSON.stringify([layout.spreadsheetId,layout.tab]));
  store.db.prepare('UPDATE scans SET synced=CASE WHEN seq < ? THEN 1 ELSE 0 END').run(layout.startSeq);
 });
 console.log(JSON.stringify({tab:layout.tab,firstAppRow:layout.startRow,startSeq:layout.startSeq,...store.stats()}));
}finally{store.close();}
