import fs from 'node:fs';
import vm from 'node:vm';
export const TOKEN='test_sync_key_0123456789_abcdefghijklmnopqrstuvwxyz';
export function gasHarness() {
  const properties={SPREADSHEET_ID:'test-sheet',SYNC_TOKEN:TOKEN,RETENTION_DAYS:'30'}, books=new Map();
  let locked=false,opens=0,uuid=0;const logs=[];
  function book(id){if(!books.has(id))books.set(id,new Map());return books.get(id);}
  function makeSheet(cells){let maxRows=Math.max(1000,cells.length),maxColumns=26;return {getMaxRows:()=>maxRows,getMaxColumns:()=>maxColumns,insertRowsAfter:(after,n)=>{maxRows+=n;},insertColumnsAfter:(after,n)=>{maxColumns+=n;},getLastRow:()=>cells.length,setFrozenRows:()=>{},deleteRows:(start,n)=>cells.splice(start-1,n),
    getRange:(r,c,n,m)=>{if(r+n-1>maxRows||c+m-1>maxColumns)throw Error('Range exceeds grid');return ({getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>cells[r-1+i]?.[c-1+j]??'')),
      setValues:values=>{for(let i=0;i<n;i++){cells[r-1+i]||=[];for(let j=0;j<m;j++)cells[r-1+i][c-1+j]=values[i][j];}}});}};}
  const context=vm.createContext({Date,JSON,Map,Set,Number,String,Array,Object,Error,Math,Utilities:{getUuid:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},Logger:{log:value=>logs.push(String(value))},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties[key]??null,setProperty:(key,value)=>{properties[key]=value;}})},
    SpreadsheetApp:{openById:id=>{opens++;const tables=book(id);return {getSheetByName:name=>tables.has(name)?makeSheet(tables.get(name)):null,insertSheet:name=>{const cells=[];tables.set(name,cells);return makeSheet(cells);}};},flush:()=>{}},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},hasLock:()=>locked,releaseLock:()=>{locked=false;}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
    ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyDays:()=>({create:()=>{}})})})},
  });
  vm.runInContext(fs.readFileSync(new URL('../../gas/Protocol.gs',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../../gas/Code.gs',import.meta.url),'utf8'),context);
  function request(body){return context.doPost({postData:{contents:JSON.stringify({protocol:1,token:TOKEN,...body})}});}
  return {request,properties,context,logs,table:name=>book(properties.SPREADSHEET_ID).get(name),seed:(name,rows)=>book(properties.SPREADSHEET_ID).set(name,structuredClone(rows)),
    get cells(){const tables=[...book(properties.SPREADSHEET_ID)].filter(([n])=>/^VRC(Friends|Events|Worlds|Runs|Accounts|Visits|Encounters)$/.test(n));return tables.length?[tables[0][1][0],...tables.flatMap(([,rows])=>rows.slice(1))]:[];},get opens(){return opens;}};
}
