const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.resolve(__dirname, '..');
const html = Object.fromEntries(['admin','productor'].map(name => [name, fs.readFileSync(path.join(project, name + '.html'), 'utf8').replace(/\r\n/g, '\n')]));
function functionSource(source, name) {
    const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name + ' exists');
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2);
}
const core = functionSource(html.productor, 'createStreamUploadController');
test('both panels use the same recovery state machine and compile', () => {
    assert.equal(functionSource(html.admin, 'createStreamUploadController'), core);
    for (const source of Object.values(html)) {
        for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    }
});
function harness({ saved = new Map(), statuses = [], responses = [], maxPolls = 3 } = {}) {
    const requests = [], views = [];
    let serial = 0, reads = 0;
    class FormData {
        constructor() { this.fields = new Map(); }
        append(name, value) { this.fields.set(name, value); }
    }
    class XMLHttpRequest {
        constructor() { this.upload = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(form) {
            requests.push(form.fields);
            this.upload.onprogress({ lengthComputable:true, loaded:100, total:100 });
            this.upload.onload();
            const reply = responses.shift() || { videoId:'video-1', operationId:form.fields.get('operationId') };
            if (reply.networkError) { this.onerror(); return; }
            this.status = reply.http || 200;
            this.responseText = reply.raw === undefined ? JSON.stringify(reply) : reply.raw;
            this.onload();
        }
    }
    const context = vm.createContext({ FormData, XMLHttpRequest, Date, crypto:{ randomUUID:() => 'test-operation-' + (++serial) },
        localStorage:{ getItem:key => saved.get(key), setItem:(key,value) => saved.set(key,value) } });
    vm.runInContext(core, context);
    const controller = context.createStreamUploadController({
        api:async () => { reads++; const next = statuses.length > 1 ? statuses.shift() : statuses[0]; if (next instanceof Error) throw next; return next || { ready:false, phase:'processing', encodeProgress:20 }; },
        prefix:'/api/producer/stream', storageKey:'test-owner', getToken:() => 'test-token',
        onUpdate:view => views.push(view), onJobsChanged:() => {}, maxPolls, delay:async () => {}
    });
    return { controller, requests, views, saved, reads:() => reads };
}
const file = { name:'lesson.mp4', size:128, lastModified:12345 };
const input = { file, title:'Lesson', courseId:'course-a', moduleId:'module-a' };
test('encoding at 100 percent stays pending until ready is explicitly true', async () => {
    const h = harness({ statuses:[{ ready:false, phase:'processing', encodeProgress:100 }] });
    await assert.rejects(h.controller.upload(input), error => error.code === 'STATUS_PENDING');
    assert.equal(h.controller.getJobs()[0].ready, false);
    assert.equal(h.views.some(view => view.phase === 'ready'), false);
    assert.equal(h.requests.length, 1);
});
test('failed status wins over a contradictory ready flag', async () => {
    const h = harness({ statuses:[{ ready:true, failed:true, error:'Transcode failed', encodeProgress:100 }] });
    await assert.rejects(h.controller.upload(input), /Transcode failed/);
    assert.equal(h.controller.getJobs()[0].ready, false);
    assert.equal(h.views.some(view => view.phase === 'ready'), false);
});
test('a rejected stage is explained with stage, provider reason and next action, and stays retryable', async () => {
    const h = harness({ statuses:[{ ready:false, failed:true, retryable:true, phase:'reserved', stage:'library-protect', stageLabel:'Protección de la biblioteca (DRM básico)',
        error:'Falló la etapa «Protección de la biblioteca (DRM básico)».', providerMessage:'Cannot have Token Authentication and Basic DRM enabled at the same time', action:'Corrige la causa y vuelve a seleccionar el archivo.' }] });
    await assert.rejects(h.controller.upload(input), error => error.code === 'UPLOAD_FAILED' && /Etapa: Protección de la biblioteca/.test(error.message) && /Servicio de video: Cannot have Token/.test(error.message) && /Corrige la causa/.test(error.message));
    const job = h.controller.getJobs()[0];
    assert.equal(job.retryable, true); assert.equal(job.stage, 'library-protect'); assert.match(job.error, /Etapa/);
    assert.equal(h.views.at(-1).phase, 'failed');
});
test('a server-side stage rejection of the upload request records the failure on the job without claiming a video', async () => {
    const h = harness({ responses:[{ http:502, error:'Bunny respondió HTTP 400.', code:'BUNNY_HTTP_ERROR', stage:'library-protect', stageLabel:'Protección de la biblioteca (DRM básico)', provider:{ status:400, errorKey:'VideoLibrary.TokenAuthAndDrmConflict', message:'Cannot have Token Authentication and Basic DRM enabled at the same time' }, retryable:false }] });
    await assert.rejects(h.controller.upload(input), error => error.code === 'UPLOAD_REJECTED' && /Etapa: Protección/.test(error.message) && /Servicio de video: Cannot have/.test(error.message));
    const job = h.controller.getJobs()[0];
    assert.equal(job.failed, true); assert.equal(job.videoId, undefined); assert.equal(job.stage, 'library-protect');
});
test('client upload completion is separate from server and encoding progress', async () => {
    const h = harness({ statuses:[{ ready:true, videoId:'video-1' }] });
    await h.controller.upload(input);
    assert.equal(h.views[1].phase, 'client-upload');
    assert.equal(h.views[1].percent, 100);
    assert.equal(h.views[2].phase, 'preparing');
    assert.equal(h.views[2].percent, null);
    assert.equal(h.views.at(-1).phase, 'ready');
});
test('lost POST response recovers after reload without uploading a second file', async () => {
    const saved = new Map();
    const first = harness({ saved, responses:[{ networkError:true }] });
    await assert.rejects(first.controller.upload(input), error => error.code === 'UPLOAD_UNCERTAIN');
    const operationId = first.requests[0].get('operationId');
    const reopened = harness({ saved, statuses:[{ ready:true, videoId:'same-video' }] });
    await reopened.controller.resume(operationId);
    assert.equal(reopened.requests.length, 0);
    assert.equal(reopened.controller.getJobs()[0].videoId, 'same-video');
    assert.equal(reopened.controller.getJobs()[0].ready, true);
});
test('an explicit safe retry reuses operationId and the same course/module', async () => {
    const saved = new Map();
    const first = harness({ saved, statuses:[{ failed:true, ready:false, retryable:true }] });
    await assert.rejects(first.controller.upload(input), error => error.code === 'UPLOAD_FAILED');
    const retry = harness({ saved, statuses:[{ failed:true, ready:false, retryable:true }, { ready:true, videoId:'same-video' }] });
    await retry.controller.upload(input);
    assert.equal(retry.requests.length, 1);
    assert.equal(retry.requests[0].get('operationId'), first.requests[0].get('operationId'));
    assert.equal(retry.requests[0].get('courseId'), 'course-a');
    assert.equal(retry.requests[0].get('moduleId'), 'module-a');
});
test('an uncertain previous operation cannot cause an automatic new POST', async () => {
    const saved = new Map();
    const first = harness({ saved, responses:[{ networkError:true }] });
    await assert.rejects(first.controller.upload(input));
    const retry = harness({ saved, statuses:[new Error('offline')] });
    await assert.rejects(retry.controller.upload(input), error => error.code === 'UPLOAD_UNCERTAIN');
    assert.equal(retry.requests.length, 0);
});
test('repeated status network errors remain recoverable and never imply ready', async () => {
    const h = harness({ statuses:[new Error('offline')], maxPolls:5 });
    await assert.rejects(h.controller.upload(input), error => error.code === 'STATUS_PENDING');
    assert.equal(h.reads(), 3);
    assert.equal(h.controller.getJobs()[0].ready, false);
});
function apiHarness(panel, replies) {
    let calls = 0, logouts = 0;
    const context = vm.createContext({ TOKEN:'test-token', showDbInitBanner:() => {}, setTimeout:fn => fn(), logout:() => logouts++,
        fetch:async () => { calls++; const reply = replies.length > 1 ? replies.shift() : replies[0]; if (reply instanceof Error) throw reply; return {
            status:reply.status, ok:reply.status >= 200 && reply.status < 300,
            headers:{ get:() => reply.html ? 'text/html' : 'application/json' }, json:async () => reply.body || {}
        }; }
    });
    vm.runInContext(functionSource(html[panel], 'api'), context);
    return { api:context.api, calls:() => calls, logouts:() => logouts };
}
test('admin never retries an ambiguous mutation on network failure or proxy error', async () => {
    for (const response of [new Error('offline'), { status:503, html:true }, { status:502, body:{ error:'Unavailable' } }]) {
        const h = apiHarness('admin', [response]);
        await assert.rejects(h.api('POST', '/api/courses', { name:'One course' }));
        assert.equal(h.calls(), 1);
    }
});
test('admin may retry a read that fails temporarily', async () => {
    const h = apiHarness('admin', [{ status:503 }, { status:200, body:{ courses:[] } }]);
    await h.api('GET', '/api/courses'); assert.equal(h.calls(), 2);
});
test('producer quota/permission denial preserves login, while 401 ends it', async () => {
    const quota = apiHarness('productor', [{ status:403, body:{ code:'QUOTA_EXCEEDED', error:'Cuota excedida' } }]);
    await assert.rejects(quota.api('POST', '/api/producer/license/generate-bulk', { quantity:2, courseId:'mine' }), error => error.status === 403);
    assert.equal(quota.logouts(), 0); assert.equal(quota.calls(), 1);
    const expired = apiHarness('productor', [{ status:401 }]);
    await assert.rejects(expired.api('GET', '/api/producer/me'));
    assert.equal(expired.logouts(), 1);
});
test('course change ignores stale module responses from the previous course', async () => {
    const nodes = Object.fromEntries(['up-course','up-module','up-btn'].map(id => [id, { value:'', innerHTML:'', disabled:false }]));
    nodes['up-course'].value = 'a';
    let finishFirst;
    const selectRenders = [];
    const context = vm.createContext({ $:id => nodes[id], _courseRequest:0, _courses:[], _modules:[], esc:String, message:() => {}, Map,
        api:async (_method,url) => url.includes('/a/') ? new Promise(resolve => { finishFirst = resolve; }) : { modules:[{ id:'b-module',name:'B' }] }
    });
    vm.runInContext(functionSource(html.productor, 'moduleOptionLabel') + functionSource(html.productor, 'fillModuleSelect') + functionSource(html.productor, 'selectCourse'), context);
    const originalFill = context.fillModuleSelect;
    context.fillModuleSelect = (select, modules, options) => { selectRenders.push(modules.map(m => m.id)); return originalFill(select, modules, options); };
    const first = context.selectCourse();
    nodes['up-course'].value = 'b'; await context.selectCourse();
    finishFirst({ modules:[{ id:'a-module',name:'A' }] }); await first;
    assert.equal(context._modules[0].id, 'b-module');
    assert.ok(!nodes['up-module'].innerHTML.includes('a-module'));
    assert.deepEqual(selectRenders.at(-1), ['b-module']);
    assert.ok(!selectRenders.flat().includes('a-module'), 'stale modules cannot be offered as upload destination in the newly selected course');
});
