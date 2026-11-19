'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const site = 'https://beamsync.test';
const root = path.resolve(__dirname,'../..');
const candidate = path.join(root,'public');
const release = fs.readFileSync(path.join(candidate,'sw.js'),'utf8').match(/const release = '([^']+)'/)[1];
const newCache = 'beamsync-v' + release;
const oldCache = 'beamsync-v13';
const suffix = '?v=' + release;
const mime = {
  '.js':'text/javascript; charset=UTF-8', '.png':'image/png', '.css':'text/css',
  '.webmanifest':'application/manifest+json', '.html':'text/html; charset=UTF-8'
};

function harness() {
  const calls = [], stores = new Map();
  let online = true, served = candidate, failWrite = null;
  const overrides = new Map();
  const absolute = input => new URL(typeof input === 'string' ? input : input.url,site).href;
  async function network(input, options={}) {
    const url = new URL(absolute(input));
    calls.push({path:url.pathname,search:url.search,options});
    if (!online) throw TypeError('Network unavailable');
    if (overrides.has(url.pathname)) return overrides.get(url.pathname)().clone();
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(served,name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Missing',{status:404});
    return new Response(fs.readFileSync(file),{headers:{'Content-Type':mime[path.extname(file)] || 'text/plain'}});
  }
  const caches = {
    async keys(){return [...stores.keys()];},
    async delete(name){return stores.delete(name);},
    async open(name) {
      let store = stores.get(name);
      if (!store) stores.set(name,store = new Map());
      return {
        async put(input,response) {
          if (failWrite && absolute(input).includes(failWrite)) throw Error('Quota exhausted');
          store.set(absolute(input),response.clone());
        },
        async addAll(keys) {
          const pending = await Promise.all(keys.map(key => network(key)));
          if (pending.some(response=>!response.ok)) throw Error('Bad package');
          for (let i=0;i<keys.length;i++) await this.put(keys[i],pending[i]);
        },
        async delete(input){return store.delete(absolute(input));},
        async match(input){return store.get(absolute(input))?.clone();}
      };
    }
  };
  function loadWorker(dir) {
    const events = new Map(), flags = {activated:false,skipped:false};
    const self = {location:new URL(site),addEventListener(type,func){events.set(type,func);},
      async skipWaiting(){flags.skipped = true;},
      clients:{async claim(){flags.activated = true;},async matchAll(){return [];}}};
    vm.runInNewContext(fs.readFileSync(path.join(dir,'sw.js'),'utf8'),{self,caches,fetch:network,URL,Response,Uint8Array});
    async function dispatch(type,event={}) {
      let deferred, handled;
      event.waitUntil = promise => {deferred = promise;};
      event.respondWith = promise => {handled = promise;};
      events.get(type)(event);
      await deferred;
      return {intercepted:handled !== undefined,response:await handled};
    }
    const serve = (url,mode='cors',method='GET') => dispatch('fetch',{request:{url:absolute(url),mode,method}});
    async function message(extra={}) {
      const replies = [];
      await dispatch('message',{data:{type:'CACHE_SHELL',...extra},source:{postMessage(msg){replies.push(msg);}}});
      return replies[0];
    }
    return {flags,dispatch,serve,message};
  }
  return {network, calls, overrides, caches, stores, loadWorker, setOnline:yes=>{online=yes;},
    serveFrom:dir=>{served=dir;}, failWrites:key=>{failWrite=key;}};
}
function checkNoNewRows(h) { return (h.stores.get(newCache)?.size ?? 0) === 0; }

test('installing the current offline package preserves a previously cached release',async () => {
  const h=harness(), old=await h.caches.open(oldCache);
  // A synthetic old-release marker checks isolation; no historical v13 source is in this export.
  const legacy='<meta name="beamsync-app" content="v13">';
  await old.put('./__beamsync_shell__',new Response(legacy,{headers:{'Content-Type':'text/html'}}));
  const current=h.loadWorker(candidate);
  await current.dispatch('install'); await current.dispatch('activate');
  assert.ok(current.flags.activated && current.flags.skipped);
  assert.match(await (await current.serve('/','navigate')).response.text(),/content="v14"/);
  assert.equal((await current.message()).type,'OFFLINE_READY');
  assert.equal(await (await old.match('./__beamsync_shell__')).text(),legacy);
});

test('release-tagged packaged shell dependencies include both UIs, module imports and install icon URLs',async () => {
  const h = harness(), sw = h.loadWorker(candidate);
  await sw.dispatch('install');
  const cache = await h.caches.open(newCache);
  for(const file of ['index.html','classic.html']) {
    const html = fs.readFileSync(path.join(candidate,file),'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+\.(?:js|css|png|webmanifest)(?:\?[^"]*)?)"/g)].map(m=>m[1]);
    assert.ok(refs.includes('./js/core.js'+suffix) && refs.includes('./js/pairing.js'+suffix));
    for (const ref of refs) {
      assert.ok(ref.endsWith(suffix),'unversioned shell dependency: ' + ref);
      assert.ok(await cache.match(ref),'uncached shell dependency: '+ref);
    }
  }
  const app = fs.readFileSync(path.join(candidate,'app.js'),'utf8');
  const imports = [...app.matchAll(/\bfrom\s+['"](.+?)['"]/g)].map(m=>m[1]);
  assert.ok(imports.length>0);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate,'manifest.webmanifest'),'utf8'));
  for(const ref of [...imports,...manifest.icons.map(icon=>icon.src)]) {
    assert.ok(ref.endsWith(suffix) && await cache.match(ref),'expected cached release resource: '+ref);
  }
});

test('a network-provided older shell and unversioned scripts are not intercepted by the current worker',async () => {
  const h=harness(), sw=h.loadWorker(candidate);
  await sw.dispatch('install');
  // This checks routing only; it does not substitute for a real v13 source fixture.
  h.overrides.set('/',()=>new Response('<meta name="beamsync-app" content="v13">',{headers:{'Content-Type':'text/html'}}));
  assert.match(await (await sw.serve('/','navigate')).response.text(),/content="v13"/);
  for (const name of ['/js/core.js','/js/pairing.js','/js/transfer.js','/js/main.js']) {
    assert.equal((await sw.serve(name)).intercepted,false);
    assert.ok((await h.network(name)).ok,'unversioned script remains accessible from network');
    const result=await sw.serve(name+suffix);
    assert.equal(await result.response.text(),fs.readFileSync(path.join(candidate,name),'utf8'));
  }
});

test('network access and login failures remain authoritative; offline tabs get distinct modern and classic shells',async () => {
  const h = harness(), sw=h.loadWorker(candidate);
  await sw.dispatch('install');
  h.overrides.set('/classic.html',()=>new Response('Sign in',{status:403}));
  const denied = await sw.serve('/classic.html','navigate');
  assert.equal(denied.response.status,403); assert.equal(await denied.response.text(),'Sign in');
  h.setOnline(false);
  for(const url of ['/','/index.html','/?_preview=opaque']) {
    const {response} = await sw.serve(url,'navigate');
    assert.equal(response.status,200); assert.match(await response.text(),/content="v14"/);
  }
  assert.match(await (await sw.serve('/classic.html','navigate')).response.text(),/content="v14-classic"/);
});

test('API routes, unrelated private paths, altered asset queries, posts and foreign origins bypass runtime caching',async () => {
  const h = harness(), sw=h.loadWorker(candidate);
  await sw.dispatch('install'); const initial=[...h.stores.get(newCache).keys()];
  for(const [url,mode,method] of [
    ['/api/quick-pair','navigate','GET'],['/api/signal','cors','POST'],['/api','navigate','GET'],
    ['/private/export','navigate','GET'],['/settings','cors','GET'],['/','cors','POST'],
    ['/app.js'+suffix+'&secret=test','cors','GET'],['/ui.js?x=private','cors','GET'],
    ['https://external.test/ui.js'+suffix,'cors','GET']
  ]) assert.equal((await sw.serve(url,mode,method)).intercepted,false,method+' '+url);
  const count = h.calls.length; await sw.message({url:site+'/private/export?private=x#secret'});
  assert.equal(h.calls.length,count);
  assert.deepEqual([...h.stores.get(newCache).keys()],initial);
  assert.ok(initial.every(key=>!key.includes('private') && !key.includes('secret')));
});

test('bad assets, mismatched release and an interrupted cache write never advertise readiness or erase v13',async () => {
  const bad = [
    ['/index.html',()=>new Response('<meta name="beamsync-app" content="v13">',{headers:{'Content-Type':'text/html'}})],
    ['/classic.html',()=>new Response('Sign in',{headers:{'Content-Type':'text/html'}})],
    ['/ui.js',()=>new Response('{"error":"maintenance"}',{headers:{'Content-Type':'application/json'}})],
    ['/ui.js',()=>new Response('<html>Login</html>',{headers:{'Content-Type':'text/javascript'}})],
    ['/ui.js',()=>new Response('',{headers:{'Content-Type':'text/javascript'}})],
    ['/icons/icon-192.png',()=>new Response('Not a PNG',{headers:{'Content-Type':'image/png'}})],
    ['/manifest.webmanifest',()=>new Response('{}',{headers:{'Content-Type':'application/manifest+json'}})],
    ['/js/main.js',()=>new Response('Not found',{status:404})]
  ];
  for (const [target,response] of bad) {
    const h=harness(); await (await h.caches.open(oldCache)).put('/v13',new Response('preserve'));
    const sw=h.loadWorker(candidate); h.overrides.set(target,response);
    await assert.rejects(sw.dispatch('install')); assert.equal(sw.flags.skipped,false);
    assert.ok(checkNoNewRows(h)); assert.equal((await sw.message()).type,'OFFLINE_CACHE_ERROR');
    assert.ok(await (await h.caches.open(oldCache)).match('/v13'));
  }
  const h=harness(),sw=h.loadWorker(candidate);
  h.failWrites('/ui.js?'); await assert.rejects(sw.dispatch('install'));
  assert.equal(sw.flags.skipped,false); assert.ok(checkNoNewRows(h));
  h.failWrites(null); await sw.dispatch('install'); assert.equal((await sw.message()).type,'OFFLINE_READY');
});

test('cold offline navigation and partial browser eviction give an explicit offline-missing response',async () => {
  const h=harness(),sw=h.loadWorker(candidate);
  h.setOnline(false);
  assert.equal((await sw.message()).type,'OFFLINE_CACHE_ERROR');
  assert.equal((await sw.serve('/','navigate')).response.status,503);
  h.setOnline(true); await sw.dispatch('install');
  await (await h.caches.open(newCache)).delete('/ui.js'+suffix);
  h.setOnline(false);
  assert.equal((await sw.message()).type,'OFFLINE_CACHE_ERROR');
  const {response}=await sw.serve('/','navigate'); assert.equal(response.status,503);
  assert.match(await response.text(),/online/);
});