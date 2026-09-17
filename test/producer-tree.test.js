'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTree, descendantIds, canReparent, countClasses, moveWithin, statusLabel } = require('../public/js/producer-tree');

const modules = [
    { id: 'a', parentId: null, sortOrder: 20, name: 'A' }, { id: 'b', parentId: null, sortOrder: 10, name: 'B' },
    { id: 'a1', parentId: 'a', sortOrder: 10, name: 'A1' }, { id: 'a1x', parentId: 'a1', sortOrder: 10, name: 'A1x' },
    { id: 'lost', parentId: 'missing-parent', sortOrder: 5, name: 'Huérfano' },
];
const videos = [{ videoId: 'v1', moduleId: 'a1x', sortOrder: 1 }, { videoId: 'v2', moduleId: 'a', sortOrder: 2 }, { videoId: 'v3', moduleId: null }, { videoId: 'v4', moduleId: 'deleted-module' }];

test('the tree nests by parentId, orders siblings and never loses modules or classes', () => {
    const tree = buildTree(modules, videos);
    assert.deepEqual(tree.roots.map(n => n.module.id), ['lost', 'b', 'a'], 'orphan-parent modules become roots; siblings follow sortOrder');
    const a = tree.roots.find(n => n.module.id === 'a');
    assert.deepEqual(a.children.map(n => n.module.id), ['a1']); assert.deepEqual(a.children[0].children.map(n => n.module.id), ['a1x']);
    assert.deepEqual(tree.orphans.map(v => v.videoId), ['v3', 'v4'], 'classes without a valid module stay visible in the Sin módulo group');
    assert.equal(countClasses(a), 2, 'a module counts the classes of its submodules');
    assert.equal(countClasses(tree.roots.find(n => n.module.id === 'b')), 0);
});
test('cyclic legacy data still renders every module once', () => {
    const cyclic = [{ id: 'x', parentId: 'y', name: 'x' }, { id: 'y', parentId: 'x', name: 'y' }, { id: 'z', parentId: null, name: 'z' }];
    const tree = buildTree(cyclic, []);
    const seen = []; const walk = n => { seen.push(n.module.id); n.children.forEach(walk); }; tree.roots.forEach(walk);
    assert.deepEqual([...seen].sort(), ['x', 'y', 'z']);
});
test('a module cannot be moved into itself, a descendant, or an unknown parent', () => {
    assert.deepEqual([...descendantIds(modules, 'a')].sort(), ['a1', 'a1x']);
    assert.equal(canReparent(modules, 'a', 'a'), false); assert.equal(canReparent(modules, 'a', 'a1x'), false);
    assert.equal(canReparent(modules, 'a', 'nope'), false); assert.equal(canReparent(modules, 'a', 'b'), true); assert.equal(canReparent(modules, 'a', null), true);
});
test('sibling moves produce the full ordered id list or nothing on invalid indexes', () => {
    const items = [{ id: '1' }, { id: '2' }, { videoId: '3' }];
    assert.deepEqual(moveWithin(items, 0, 2), ['2', '3', '1']); assert.deepEqual(moveWithin(items, 2, 0), ['3', '1', '2']);
    assert.equal(moveWithin(items, 1, 1), null); assert.equal(moveWithin(items, 5, 0), null); assert.equal(moveWithin(items, 0, -1), null);
});
test('class statuses map to the visible labels used in the tree', () => {
    assert.deepEqual(statusLabel('ready'), ['Listo', 'good']); assert.deepEqual(statusLabel('processing'), ['Procesando', 'wait']);
    assert.deepEqual(statusLabel('error'), ['Error', 'bad']); assert.deepEqual(statusLabel(undefined), ['Pendiente', 'wait']);
});
