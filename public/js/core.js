(()=>{
'use strict';
const $=id=>document.getElementById(id),enc=new TextEncoder(),dec=new TextDecoder();
const STUN={iceServers:[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.nextcloud.com:443'}],iceCandidatePoolSize:2};
const LAN={iceServers:[]};
const S={pairing:'direct',role:null,stage:'idle',attempt:0,pc:null,dc:null,directRescueRound:0,timers:[]};
const hooks={onConnected:null,onFailed:null,onMessage:null,onClosed:null};
function log(s){const el=$('log');if(!el)return;el.textContent+=`\n[${new Date().toLocaleTimeString()}] ${s}`;el.scrollTop=el.scrollHeight}
function show(id,v=true){$(id)?.classList.toggle('hidden',!v)}
function status(s,c=''){const el=$('status');if(el){el.className='status '+c;el.textContent=s}log(s)}
function progress(s,c='subtle'){const el=$('pairProgress');if(el){el.className='status '+c;el.textContent=s}}
function addTimer(fn,ms){const t=setTimeout(fn,ms);S.timers.push(t);return t}
function clearTimers(){for(const t of S.timers)clearTimeout(t);S.timers=[]}
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KiB';if(n<1073741824)return(n/1048576).toFixed(1)+' MiB';return(n/1073741824).toFixed(2)+' GiB'}
function randId(n=10){const b=new Uint8Array(n);crypto.getRandomValues(b);return[...b].map(x=>x.toString(16).padStart(2,'0')).join('')}
function hex(buf){return[...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function b64u(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function unb64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const x=atob(s),o=new Uint8Array(x.length);for(let i=0;i<x.length;i++)o[i]=x.charCodeAt(i);return o}
function beginAttempt(){S.attempt++;clearTimers();S.directRescueRound=0;return S.attempt}
function hardClose(){clearTimers();try{S.dc?.close()}catch{}try{S.pc?.close()}catch{}S.dc=null;S.pc=null}
function candidateInfo(c){const s=c?.candidate||'',t=c?.type||(s.match(/ typ (host|srflx|prflx|relay)/)||[])[1]||'unknown',p=c?.protocol||(s.match(/candidate:\S+ \d+ (udp|tcp)/i)||[])[1]||'?';return`${t}/${String(p).toLowerCase()}`}
function wireChannel(c){S.dc=c;S.dc.binaryType='arraybuffer';log(`DataChannel ${S.role==='A'?'created':'received'}; ordered=${S.dc.ordered}`);S.dc.onopen=()=>hooks.onConnected?.();S.dc.onclose=()=>{log('DataChannel closed');hooks.onClosed?.()};S.dc.onerror=e=>log('DataChannel error: '+(e?.error?.message||e?.message||'unknown'));S.dc.onmessage=e=>hooks.onMessage?.(e)}
function makePC(mode){try{S.pc?.close()}catch{}S.pc=new RTCPeerConnection(mode==='lan'?LAN:STUN);const p=S.pc;p.ondatachannel=e=>wireChannel(e.channel);p.onicecandidate=e=>{if(e.candidate)log('ICE candidate: '+candidateInfo(e.candidate));else log('ICE gathering signaled complete')};p.onicecandidateerror=e=>log(`ICE candidate error: ${e.errorCode||''} ${e.errorText||''}`);p.onicegatheringstatechange=()=>log('ICE gathering: '+p.iceGatheringState);p.oniceconnectionstatechange=()=>{log('ICE: '+p.iceConnectionState);if(['connected','completed','failed'].includes(p.iceConnectionState))pairStats()};p.onconnectionstatechange=()=>{log('Peer: '+p.connectionState);if(['connected','failed'].includes(p.connectionState))pairStats();if(p.connectionState==='failed')hooks.onFailed?.()};return p}
function waitIce(p,ms=18000){if(p.iceGatheringState==='complete')return Promise.resolve();return new Promise(r=>{let done=false;const finish=why=>{if(done)return;done=true;p.removeEventListener('icegatheringstatechange',chg);log('ICE gathering finished by '+why);r()},chg=()=>{if(p.iceGatheringState==='complete')finish('browser completion')};p.addEventListener('icegatheringstatechange',chg);setTimeout(()=>finish('timeout'),ms)})}
async function pairStats(){try{const stats=await S.pc?.getStats();if(!stats)return;let pair;stats.forEach(x=>{if(x.type==='candidate-pair'&&(x.nominated||x.state==='succeeded'))pair=pair||x});if(!pair)return;const l=stats.get(pair.localCandidateId),r=stats.get(pair.remoteCandidateId),route=`${l?.candidateType||'?'} / ${l?.protocol||'?'} → ${r?.candidateType||'?'} / ${r?.protocol||'?'}`;log('Selected route: '+route);if($('routeText'))$('routeText').textContent=`WebRTC DataChannel is open. Route: ${route}.`}catch(e){log('Stats unavailable: '+e.message)}}
window.BeamSyncCore={$,enc,dec,STUN,LAN,S,hooks,log,show,status,progress,addTimer,clearTimers,fmtBytes,randId,hex,b64u,unb64u,beginAttempt,hardClose,makePC,wireChannel,waitIce,pairStats};
})();