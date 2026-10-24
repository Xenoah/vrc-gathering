import fs from 'node:fs';
import vm from 'node:vm';
export const TOKEN='test_sync_key_0123456789_abcdefghijklmnopqrstuvwxyz';
export function gasHarness() {
  const properties={SPREADSHEET_ID:'test-sheet',SYNC_TOKEN:TOKEN,RETENTION_DAYS:'30'}, cells=[];
  let locked=false, opens=0;
  const sheet={getLastRow:()=>cells.length,setFrozenRows:()=>{},deleteRows:(start,n)=>cells.splice(start-1,n),
    getRange:(r,c,n,m)=>({getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>cells[r-1+i]?.[c-1+j]??'')),
      setValues:values=>{for(let i=0;i<n;i++){cells[r-1+i]||=[];for(let j=0;j<m;j++)cells[r-1+i][c-1+j]=values[i][j];}}})};
  const context=vm.createContext({Date,JSON,Map,Set,Number,String,Array,Object,Error,Math,
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties[key]??null,setProperty:(key,value)=>{properties[key]=value;}})},
    SpreadsheetApp:{openById:()=>{opens++;return {getSheetByName:()=>cells.length?sheet:null,insertSheet:()=>sheet};},flush:()=>{}},
    LockService:{getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},hasLock:()=>locked,releaseLock:()=>{locked=false;}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
  });
  vm.runInContext(fs.readFileSync(new URL('../../gas/Protocol.gs',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../../gas/Code.gs',import.meta.url),'utf8'),context);
  function request(body){return context.doPost({postData:{contents:JSON.stringify({protocol:1,token:TOKEN,...body})}});}
  return {request,cells,properties,context,get opens(){return opens;}};
}
