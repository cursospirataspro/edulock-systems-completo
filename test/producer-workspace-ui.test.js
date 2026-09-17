'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/js/producer-workspace.js'),'utf8');

function harness() {
  const nodes=new Map(),requests=[];
  class Node {
    constructor(){this.value='';this.textContent='';this.innerHTML='';this.children=[];this.disabled=false;this.hidden=false;this.open=false;this.dataset={};this.attributes={};this.listeners={};this.classList={add(){},remove(){},toggle(){return false;},contains(){return false;}};}
    replaceChildren(...children){this.children=children;}
    append(...children){this.children.push(...children);}
    after(...children){this.children.push(...children);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){delete this.attributes[name];}
    querySelector(){const n=new Node();this.append(n);return n;}
    querySelectorAll(){return [];}
    showModal(){this.open=true;}
    close(){this.open=false;}
    focus(){}
    remove(){}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const sections=['proyectos','videos','licencias'].map(page=>{const n=new Node();n.dataset.workspacePage=page;return n;});
  const nav=sections.map(section=>{const n=new Node();n.dataset.page=section.dataset.workspacePage;return n;});
  const document={getElementById:node,createElement:()=>new Node(),querySelectorAll:selector=>selector==='[data-page]'?nav:selector==='[data-workspace-page]'?sections:[],body:new Node()};
  const context=vm.createContext({document,window:{addEventListener(){}},location:{origin:'https://edulock.example.invalid',hash:''},history:{replaceState(){}},sessionStorage:{setItem(){},getItem(){}},localStorage:{setItem(){},removeItem(){}},
    URL,URLSearchParams,Date,Number,Object,Array,String,Promise,Map,setTimeout,clearTimeout,TOKEN:'',_licensePage:1,_licenseRequest:0,_me:{id:'producer',quotas:{maxDevices:3}},
    esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),message(){},showApp:async()=>{},selectCourse:async()=>{},loadCourses:async()=>{},logout(){},genLicenses:async()=>{requests.push({method:'GENERATE',project:node('lic-course').value,scope:node('up-course').value,query:node('license-search').value,status:node('license-status-filter').value});},loadLots:async()=>{},loadVideos:async()=>{},loadLicenseItems:async()=>{},loadActivations:async()=>{},refreshProfile:async()=>{},producerLicenseQuota:()=>({devices:3}),
    api:async(method,route,body)=>{requests.push({method,route,body});return {lots:[],licenses:[],page:1,pageSize:30,total:0};},
    FormData:class {constructor(){return context.fields[Symbol.iterator]();}},fields:[],navigator:{clipboard:{writeText:async()=>{}}}
  });
  vm.runInContext(source.replace('if(TOKEN)showApp();','globalThis.workspaceTest={state,editLicense,confirmAction,navigate,allVideos,showEmbed,refreshProjects,integrations,mailResultMessage,emailLicense,syncLicenseScope};'),context);
  const submit=async fields=>{context.fields=Object.entries(fields);return node('workspace-form').onsubmit({preventDefault(){}});};
  return {context,node,requests,sections,nav,submit,workspace:context.workspaceTest};
}

test('an assigned license opens read-only with the full key, student link and no editable limit or validity',async()=>{
  const h=harness();const license={id:'own-license',courseName:'Own course',status:'active',availability:'in_use',maxDevices:2,serial:'ABCD-EFGH-JKLM-NPQR',serialAvailable:true,studentId:'student-a',studentEmail:'buyer@example.invalid',customerEmail:'buyer@example.invalid',activeActivations:1,createdAt:'2026-01-01T00:00:00Z'};
  h.workspace.editLicense(license);
  assert.equal(h.requests.length,0,'opening an editor is read-only');
  const body=h.node('workspace-dialog-body').innerHTML;
  assert.match(body,/ABCD-EFGH-JKLM-NPQR/);assert.match(body,/límite fijado por el administrador/);
  assert.doesNotMatch(body,/name="maxDevices"|name="expiresAt"|name="durationDays"|name="buyerPhone"|name="orderId"|name="notes"/);
  assert.equal(h.node('workspace-dialog-submit').hidden,true,'nothing to save on an assigned license');
  await h.submit({customerEmail:'other@example.invalid'});
  assert.equal(h.requests.some(r=>r.method==='PATCH'),false,'an assigned license cannot be transferred from the dialog');
});

test('a free key can be reserved for an email, and revoked keys cannot save',async()=>{
  const h=harness();h.workspace.editLicense({id:'l',status:'free',availability:'available',maxDevices:1,serial:'ABCD-EFGH-JKLM-NPQR',serialAvailable:true});
  await h.submit({customerEmail:'buyer@example.invalid'});
  const reservation=h.requests.find(r=>r.method==='PATCH');assert.equal(reservation.body.customerEmail,'buyer@example.invalid');assert.equal(Object.keys(reservation.body).join(','),'customerEmail');
  const before=h.requests.length;h.workspace.editLicense({id:'revoked',status:'revoked',availability:'revoked',maxDevices:1});
  assert.equal(h.node('workspace-dialog-submit').hidden,true);
  await h.submit({customerEmail:'x@example.invalid'});assert.equal(h.requests.length,before);
});

test('destructive confirmation remains read-only until explicit submit; closing cancels',async()=>{
  const h=harness();let count=0;h.workspace.confirmAction('Delete','Cannot undo',async()=>{count++;});
  assert.equal(count,0);h.node('workspace-dialog-cancel').listeners.click();assert.equal(count,0);
  h.workspace.confirmAction('Delete','Cannot undo',async()=>{count++;});await h.submit({});assert.equal(count,1);assert.equal(h.node('workspace-dialog').open,false);
});

test('navigation switches the visible workspace section without modifying content',async()=>{
  const h=harness();await h.workspace.navigate('licencias');
  assert.deepEqual(h.sections.map(s=>s.hidden),[true,true,false]);assert.equal(h.node('workspace-title').textContent,'Licencias y lotes');
  assert.equal(h.nav[2].attributes['aria-current'],'page');assert.equal(h.requests.length,0);
  await h.workspace.navigate('compradores');assert.equal(h.node('workspace-title').textContent,'Estudiantes','old links land on the replacement page');
});

test('unassigned legacy videos remain available and unsafe embedding is refused',()=>{
  const h=harness();h.workspace.state.projects=[{id:'p',name:'Project',videos:[{videoId:'v1'}]}];h.workspace.state.unassignedVideos=[{videoId:'legacy'}];
  assert.equal(h.workspace.allVideos().length,2);assert.equal(h.workspace.allVideos()[1].courseName,'Sin proyecto');
  assert.throws(()=>h.workspace.showEmbed('Test','javascript:alert(1)',{settings:{embedOrigins:['https://example.invalid']}}),/enlace/);
  h.workspace.showEmbed('Test','/cover/example',{settings:{embedOrigins:[]}});assert.match(h.node('workspace-dialog-body').innerHTML,/sitio web autorizado/);
  assert.equal(h.requests.length,0);
});

test('integration scopes returned as text do not break the key list or expose private keys',async()=>{
  const h=harness();h.context.api=async()=>({keys:[{id:'i',name:'Store',active:true,scopes:'claim-license'}],claimUrl:'https://edulock.example.invalid/api/integrations/claim-license',mailConfigured:false});
  await h.workspace.integrations();assert.match(h.node('integration-example').textContent,/x-api-key: TU_CLAVE_PRIVADA/);assert.match(h.node('integration-example').textContent,/comprador debe estar registrado/);
  assert.equal(h.node('integration-keys').children.length,1);
});

test('generation aligns the project scope and clears filters that would hide the new free lot',async()=>{
  const h=harness();h.node('up-course').value='project-a';h.node('lic-course').value='project-b';h.node('license-search').value='old-buyer';h.node('license-status-filter').value='revoked';h.node('license-lot-filter').value='old-lot';
  await h.context.genLicenses();const generation=h.requests.find(r=>r.method==='GENERATE');
  assert.equal(generation.project,'project-b');assert.equal(generation.scope,'project-b');assert.equal(generation.query,'');assert.equal(generation.status,'');
  assert.equal(h.node('license-lot-filter').value,'');assert.equal(h.node('lic-course').disabled,false);assert.equal(h.node('up-course').disabled,false);
});

test('only confirmed queued, sending or accepted mail states can show a positive result',()=>{
  const h=harness();assert.match(h.workspace.mailResultMessage({status:'queued'}),/preparado/);assert.match(h.workspace.mailResultMessage({status:'sending'}),/en curso/);assert.match(h.workspace.mailResultMessage({status:'accepted'}),/no confirma la entrega/);
  for(const value of ['failed','cancelled','manual_review','unexpected',undefined])assert.throws(()=>h.workspace.mailResultMessage({status:value}));
});

test('a mail retry conflict remains in the dialog without claiming a prepared email',async()=>{
  const h=harness();h.context.api=async()=>{throw Object.assign(new Error('El envío requiere revisión antes de reintentar.'),{code:'MAIL_RETRY_REQUIRED',status:409});};
  h.workspace.emailLicense({id:'own',customerEmail:'buyer@example.invalid'});await h.submit({});
  assert.equal(h.node('workspace-dialog').open,true);assert.match(h.node('workspace-dialog-msg').textContent,/requiere revisión/);assert.doesNotMatch(h.node('workspace-dialog-msg').textContent,/preparado/);
});
