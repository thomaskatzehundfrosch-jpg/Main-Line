const memory=new Map();let connection;export let storageWarning=null;
async function db(){if(typeof indexedDB==='undefined')return null;if(!connection)connection=new Promise((resolve,reject)=>{const r=indexedDB.open('opening-lab-device-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('items');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return connection;}
export async function get(k){if(memory.has(k))return memory.get(k);try{const d=await db();if(!d)return memory.get(k);return (await new Promise((resolve,reject)=>{const r=d.transaction('items').objectStore('items').get(k);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}))??memory.get(k);}catch{return memory.get(k);}}
export async function put(k,v){try{const d=await db();if(!d){memory.set(k,v);return;}await new Promise((resolve,reject)=>{const tx=d.transaction('items','readwrite');tx.objectStore('items').put(v,k);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});if(!k.startsWith('asset:')){memory.set(k,v);if(memory.size>800)memory.delete(memory.keys().next().value);}}catch{memory.set(k,v);storageWarning='Device storage unavailable or full. Work is only in memory; export JSON before closing.';}}
export async function download(url,onProgress){let cached=await get('asset:'+url);if(cached){onProgress?.(cached.byteLength,cached.byteLength);return cached;}
 const r=await fetch(url);if(!r.ok)throw Error('Download failed: '+r.status+' '+url);const size=Number(r.headers.get('content-length'))||0;const reader=r.body.getReader(),chunks=[];let loaded=0;
 while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.length;onProgress?.(loaded,size);}
 const bytes=new Uint8Array(loaded);let offset=0;for(const ch of chunks){bytes.set(ch,offset);offset+=ch.length;}await put('asset:'+url,bytes.buffer);return bytes.buffer;
}

// Small completed searches stay in RAM. Persist them off the critical search path.
const pending=new Map();let flushTimer=null,flushing=null;
export function deferPut(k,v){memory.set(k,v);if(memory.size>800)memory.delete(memory.keys().next().value);pending.set(k,v);if(!flushTimer)flushTimer=setTimeout(()=>{flushTimer=null;void flushPending();},500);}
export async function flushPending(){if(flushing)await flushing;if(!pending.size)return;const batch=[...pending];pending.clear();flushing=(async()=>{try{const d=await db();if(!d)return;await new Promise((resolve,reject)=>{const tx=d.transaction('items','readwrite'),store=tx.objectStore('items');for(const [k,v]of batch)store.put(v,k);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch{storageWarning='Device storage unavailable or full. Export JSON before closing.';}})();try{await flushing;}finally{flushing=null;}}
