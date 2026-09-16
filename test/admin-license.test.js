const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
function source(name) {
    const start = html.indexOf('async function ' + name + '(');
    assert.ok(start >= 0);
    return html.slice(start, html.indexOf('\n}', start) + 2);
}
function harness(courseId) {
    const nodes = { 'lot-course':{ value:courseId }, 'lot-qty':{ value:'2' }, 'lot-maxdev':{ value:'2' },
        'lot-notes':{ value:'' }, 'lot-keys':{ value:'' }, 'lot-result':{ style:{} } };
    const calls = [], alerts = [];
    let confirmations = 0;
    const context = vm.createContext({ $:id => nodes[id], _lastLotKeys:[],
        alert:text => alerts.push(text), confirm:() => { confirmations++; return true; },
        api:async (method,url,body) => { calls.push({ method,url,body }); return { keys:['synthetic-1','synthetic-2'] }; }, loadLots:() => {}
    });
    vm.runInContext(source('generateBulk'), context);
    return { run:context.generateBulk, nodes, calls, alerts, confirmations:() => confirmations };
}
test('an empty course cannot confirm or submit an admin license batch', async () => {
    for (const value of ['', '   ']) {
        const h = harness(value); await h.run();
        assert.equal(h.calls.length, 0); assert.equal(h.confirmations(), 0);
        assert.match(h.alerts[0], /Selecciona un curso/);
    }
});
test('a selected course is attached to the batch request', async () => {
    const h = harness('course-owned'); await h.run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, '/api/license/generate-bulk');
    assert.equal(h.calls[0].body.courseId, 'course-owned');
    assert.equal(h.calls[0].body.quantity, 2);
    assert.equal(h.nodes['lot-result'].style.display, 'block');
});
test('license selector offers a required selection instead of unrestricted licenses', async () => {
    const nodes = { 'lot-course':{ innerHTML:'' }, 'edu-course':{ innerHTML:'' }, 'eu-course':{ innerHTML:'' } };
    const context = vm.createContext({ $:id => nodes[id], allCoursesCache:[{ id:'course-a',name:'Course A' }], esc:String,
        loadLots:() => {}, loadIntegrationKeys:() => {}, loadEdu:() => {}, loadBunnyStorage:() => {}, loadBunnyAccountKey:() => {}
    });
    vm.runInContext(source('loadLicensesPage'), context); await context.loadLicensesPage();
    assert.match(nodes['lot-course'].innerHTML, /Selecciona un curso/);
    assert.doesNotMatch(nodes['lot-course'].innerHTML, /Sin curso específico/);
    assert.match(nodes['lot-course'].innerHTML, /Course A/);
    assert.match(nodes['edu-course'].innerHTML, /Sin curso específico/);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});
