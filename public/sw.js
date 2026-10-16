const CACHE='beamsync-offline-v7';
const STATIC=[
  './manifest.webmanifest',
  './vendor/qrcode.min.js',
  './vendor/jsQR.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const SHELL_KEY='./__beamsync_shell__';
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(self.clients.claim());
});
async function cleanupOldCaches(){
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('beamsync-offline-')&&k!==CACHE).map(k=>caches.delete(k)));
}
async function findShell(){
  const current=await caches.open(CACHE);
  let shell=await current.match(SHELL_KEY);
  if(shell)return shell;
  const keys=await caches.keys();
  for(const key of keys){
    if(!key.startsWith('beamsync-offline-')||key===CACHE)continue;
    shell=await (await caches.open(key)).match(SHELL_KEY);
    if(shell)return shell;
  }
  return null;
}
async function notifyClients(message){
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of clients)client.postMessage(message);
}
self.addEventListener('message',event=>{
  const m=event.data||{};
  if(m.type!=='CACHE_SHELL'||typeof m.url!=='string')return;
  event.waitUntil((async()=>{
    try{
      const u=new URL(m.url);
      if(u.origin!==self.location.origin)throw new Error('wrong origin');
      const r=await fetch(u.href,{credentials:'include',cache:'no-store'});
      const type=r.headers.get('content-type')||'';
      const text=await r.clone().text();
      if(!r.ok||!type.includes('text/html')||!text.includes('name="beamsync-app"'))throw new Error('not BeamSync shell');
      const c=await caches.open(CACHE);
      await c.put(SHELL_KEY,new Response(text,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}}));
      await cleanupOldCaches();
      await notifyClients({type:'OFFLINE_READY',cache:CACHE});
    }catch(err){const existing=await findShell();if(existing)await notifyClients({type:'OFFLINE_READY',cache:CACHE});else await notifyClients({type:'OFFLINE_CACHE_ERROR',message:String(err?.message||err)})}
  })());
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const u=new URL(req.url);
  if(u.origin!==self.location.origin)return;
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      const c=await caches.open(CACHE);
      if(u.searchParams.has('_preview')){
        try{
          const r=await fetch(req);
          if(r.ok){
            const type=r.headers.get('content-type')||'';
            if(type.includes('text/html')){
              const text=await r.clone().text();
              if(text.includes('name="beamsync-app"'))await c.put(SHELL_KEY,new Response(text,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}}));
            }
          }
          return r;
        }catch{}
      }
      const shell=await findShell();
      if(shell)return shell;
      try{return await fetch(req)}catch{return new Response('<!doctype html><title>BeamSync offline</title><meta name="viewport" content="width=device-width"><p>BeamSync has not finished caching on this device yet. Reconnect once, open BeamSync, and wait for “Offline package ready”.</p>',{headers:{'Content-Type':'text/html; charset=utf-8'}})}
    })());
    return;
  }
  event.respondWith((async()=>{
    const c=await caches.open(CACHE);
    const hit=await c.match(req,{ignoreSearch:false});
    if(hit)return hit;
    try{
      const r=await fetch(req);
      if(r.ok)await c.put(req,r.clone());
      return r;
    }catch{return new Response('',{status:504,statusText:'Offline'})}
  })());
});