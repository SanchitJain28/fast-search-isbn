import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {google} from 'googleapis';
import {normalizeIsbn} from '../server/store.js';

// One-time preparation of the existing legacy Scan tab. Does not change the VPS database.
const root=fileURLToPath(new URL('../',import.meta.url));
if(fs.existsSync(path.join(root,'.env.local')))process.loadEnvFile(path.join(root,'.env.local'));
const spreadsheetId=process.env.SHEETS_SPREADSHEET_ID;
if(!spreadsheetId)throw Error('Set SHEETS_SPREADSHEET_ID');
const login=JSON.parse(fs.readFileSync(path.join(root,'data/deployment-login.json'),'utf8'));
const state=await(await fetch(login.url+'/api/state',{headers:{Authorization:'Basic '+Buffer.from(login.username+':'+login.password).toString('base64')}})).json();
if(!Array.isArray(state.scans)||!state.ready)throw Error('Central packing history unavailable');
const imports=state.scans.filter(s=>s.station==='Imported history').sort((a,b)=>a.seq-b.seq);
if(!imports.length)throw Error('No imported history to reconcile');
const startSeq=imports.at(-1).seq+1;
if(imports.some((s,i)=>s.seq!==i+1)||state.scans.some(s=>s.station!=='Imported history'&&s.seq<startSeq))throw Error('Historical sequence is not contiguous');
const auth=new google.auth.GoogleAuth({keyFile:process.env.GOOGLE_APPLICATION_CREDENTIALS||path.join(root,'credentials.json'),scopes:['https://www.googleapis.com/auth/spreadsheets']});
const sheets=google.sheets({version:'v4',auth});
const callOptions={timeout:60000};
const doc=(await sheets.spreadsheets.get({spreadsheetId,fields:'spreadsheetId,sheets(properties,conditionalFormats,protectedRanges)'},callOptions)).data;
const sheet=doc.sheets.find(s=>s.properties.title==='Scan')?.properties;
if(!sheet)throw Error('Scan tab not found');
const raw=(await sheets.spreadsheets.values.batchGet({spreadsheetId,ranges:[`Scan!A1:J${sheet.gridProperties.rowCount}`,'Progress!A1:D25'],valueRenderOption:'UNFORMATTED_VALUE'},callOptions)).data;
const values=raw.valueRanges[0].values||[];
const occupied=values.map((v,i)=>({row:i+1,values:v})).filter(r=>r.row>=4&&String(r.values[0]??'').trim());
if(occupied.length!==imports.length)throw Error(`Main Scan contains ${occupied.length} attempts, but ${imports.length} were imported. Stop direct Sheet scanning and reconcile before switching.`);
const canonical=value=>normalizeIsbn(value)||String(value??'').trim();
for(let i=0;i<imports.length;i++){
 const v=occupied[i].values,s=imports[i];
 if(canonical(v[0])!==canonical(s.isbn)||String(v[3]||'').trim()!==s.status||(s.statusType==='PACK'&&String(v[1]).trim()!==s.order))throw Error(`Historical row ${occupied[i].row} differs from the imported packing record`);
}
const lastRow=occupied.at(-1).row;
if(values.slice(lastRow).some(row=>row.some(value=>String(value??'').trim())))throw Error('Nonempty values exist after the last scanned barcode; refusing to clear them');
const layout={version:1,spreadsheetId,tab:'Scan',sheetId:sheet.sheetId,startSeq,startRow:lastRow+1,historicalCount:imports.length,historicalLastRow:lastRow,
 historyHash:createHash('sha256').update(JSON.stringify(imports.map(s=>[s.id,s.isbn,s.order,s.statusType]))).digest('hex')};
const output=path.join(root,'data/main-scan-switch');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'plan.json'),JSON.stringify(layout,null,2));
console.log(JSON.stringify({layout,appScansToBackfill:state.scans.filter(s=>s.seq>=startSeq).length,apply:process.argv.includes('--apply')},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const formula=(await sheets.spreadsheets.values.batchGet({spreadsheetId,ranges:[`Scan!A1:J${sheet.gridProperties.rowCount}`,'Progress!A1:D25'],valueRenderOption:'FORMULA'},callOptions)).data;
const backupFile=path.join(output,`sheet-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
fs.writeFileSync(backupFile,JSON.stringify({doc,raw,formula,layout},null,2));
console.log(`Full cell values/formulas backup saved to ${backupFile}`);
// Freeze historical visible results BEFORE removing their obsolete helper formulas.
for(let first=4;first<=lastRow;first+=1000){
 const end=Math.min(lastRow,first+999);
 const block=Array.from({length:end-first+1},(_,i)=>Array.from({length:3},(_,c)=>values[first+i-1]?.[c+1]??''));
 await sheets.spreadsheets.values.update({spreadsheetId,range:`Scan!B${first}:D${end}`,valueInputOption:'RAW',requestBody:{values:block}},callOptions);
}
await sheets.spreadsheets.values.batchClear({spreadsheetId,requestBody:{ranges:[`Scan!B${lastRow+1}:J${sheet.gridProperties.rowCount}`,`Scan!F4:J${lastRow}`]}},callOptions);
// Hidden F:J now store stable request IDs, sequence, station, result, copy; visible A:D are retained.
for(let first=0;first<imports.length;first+=1000){
 const batch=imports.slice(first,first+1000);
 await sheets.spreadsheets.values.batchUpdate({spreadsheetId,requestBody:{valueInputOption:'RAW',data:batch.map((scan,i)=>({range:`Scan!F${occupied[first+i].row}:J${occupied[first+i].row}`,values:[[scan.id,scan.seq,scan.station,scan.statusType,scan.copyNum]]}))}},callOptions);
}
await sheets.spreadsheets.values.batchUpdate({spreadsheetId,requestBody:{valueInputOption:'RAW',data:[
 {range:'Scan!A2',values:[['Scan books in the website. This tab receives confirmed results automatically from the central VPS; do not scan into these cells.']]},
 {range:'Scan!E3:J3',values:[['Scanned at (UTC)','Request ID','Server sequence','Station','Result','Copy']]}
]}},callOptions);
await sheets.spreadsheets.batchUpdate({spreadsheetId,requestBody:{requests:[{updateDimensionProperties:{range:{sheetId:sheet.sheetId,dimension:'COLUMNS',startIndex:5,endIndex:10},properties:{hiddenByUser:true},fields:'hiddenByUser'}}]}},callOptions);
const progress=raw.valueRanges[1].values||[];
const formulas=[];
const orders=new Set(imports.filter(scan=>scan.statusType==='PACK').map(scan=>scan.order));
for(let i=0;i<progress.length;i++){
 const row=progress[i],label=String(row[0]??''),r=i+1;
 if(orders.has(label)){
  if(label)formulas.push({range:`Progress!C${r}`,values:[[`=COUNTIFS(Scan!$B$4:$B,$A${r},Scan!$I$4:$I,"PACK")`]]});
 }
 if(label==='Total scanned')formulas.push({range:`Progress!B${r}`,values:[['=COUNTA(Scan!$F$4:$F)']]});
 if(label==='Duplicates caught')formulas.push({range:`Progress!B${r}`,values:[['=COUNTIF(Scan!$I$4:$I,"DUPLICATE")']]});
 if(label==='Not found')formulas.push({range:`Progress!B${r}`,values:[['=COUNTIF(Scan!$I$4:$I,"NOT_FOUND")']]});
}
await sheets.spreadsheets.values.batchUpdate({spreadsheetId,requestBody:{valueInputOption:'USER_ENTERED',data:formulas}},callOptions);
const verify=(await sheets.spreadsheets.values.get({spreadsheetId,range:`Scan!A1:D${lastRow}`,valueRenderOption:'UNFORMATTED_VALUE'},callOptions)).data.values||[];
for(let i=3;i<lastRow;i++)for(let c=0;c<4;c++)if(String(verify[i]?.[c]??'')!==String(values[i]?.[c]??''))throw Error(`Visible history changed at row ${i+1}, column ${c+1}; restore from ${backupFile}`);
fs.writeFileSync(path.join(output,'prepared.json'),JSON.stringify({...layout,preparedAt:new Date().toISOString(),backupFile},null,2));
console.log('Main Scan prepared; historical A:D verified unchanged. Switch the VPS target using the prepared layout.');
