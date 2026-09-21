export type Recording={scope:string;id:string;next:number;updatedAt:number};
export type Section={session:string;index:number;audio?:Blob;text?:string;warning?:string};
let database:Promise<IDBDatabase>|undefined;
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{
 const req=indexedDB.open('rivendell:dictation',1);
 req.onupgradeneeded=()=>{req.result.createObjectStore('recordings',{keyPath:'scope'});req.result.createObjectStore('sections',{keyPath:['session','index']});};
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>{database=undefined;reject(req.error);};
});}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction,done:(value:T)=>void)=>void):Promise<T>{
 const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(stores,mode);let value:T;run(tx,v=>{value=v;});tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Recording storage interrupted'));});
}
export const loadRecording=(scope:string)=>transaction<Recording|undefined>(['recordings','sections'],'readwrite',(tx,done)=>{
 const store=tx.objectStore('recordings'),cursor=store.openCursor();
 cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;const recording=row.value as Recording;
  if(!recording.updatedAt||Date.now()-recording.updatedAt>7*24*60*60_000){tx.objectStore('sections').delete(IDBKeyRange.bound([recording.id,0],[recording.id,Number.MAX_SAFE_INTEGER]));row.delete();}
  else if(recording.scope===scope)done(recording);
  row.continue();
 };
});
export const saveRecording=(record:Recording)=>transaction<void>(['recordings'],'readwrite',tx=>{tx.objectStore('recordings').put(record);});
export const saveSection=(record:Recording,section:Section)=>transaction<void>(['recordings','sections'],'readwrite',tx=>{tx.objectStore('recordings').put({...record,updatedAt:Date.now()});tx.objectStore('sections').put(section);});
export const loadSection=(session:string,index:number)=>transaction<Section|undefined>(['sections'],'readonly',(tx,done)=>{const req=tx.objectStore('sections').get([session,index]);req.onsuccess=()=>done(req.result);});
export const finishSection=(section:Section)=>transaction<void>(['sections'],'readwrite',tx=>{tx.objectStore('sections').put(section);});
export const clearRecording=(record:Recording)=>transaction<void>(['recordings','sections'],'readwrite',tx=>{tx.objectStore('recordings').delete(record.scope);tx.objectStore('sections').delete(IDBKeyRange.bound([record.id,0],[record.id,Number.MAX_SAFE_INTEGER]));});
