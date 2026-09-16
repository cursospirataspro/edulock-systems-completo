'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateContent, LIMITS } = require('../lib/resource-repository');
const link = extra => ({ name: 'Material libre', type: 'link', protection: 'public', publicUrl: 'https://example.invalid/material.pdf', ...extra });
const pdf = extra => ({ name: 'Manual', type: 'document', protection: 'protected', publicUrl: null, storageKey: randomUUID(), mimeType: 'application/pdf', byteSize: 100, pageCount: 2, ...extra });
const rejects = (input, code) => assert.throws(() => validateContent(input), { code });

test('public HTTP/HTTPS links and downloadable PDF files remain distinct supported sources', () => {
    assert.equal(validateContent(link()).publicUrl, 'https://example.invalid/material.pdf');
    assert.equal(validateContent(link({ publicUrl: 'http://example.invalid/path?q=a%20b#p1', type: 'zip' })).type, 'zip');
    const value = validateContent(pdf({ protection: 'public' }));
    assert.equal(value.protection, 'public'); assert.equal(value.publicUrl, null); assert.ok(value.storageKey);
});
test('protected PDF has no public URL and retains verified file metadata', () => {
    const input = pdf(); const value = validateContent(input);
    assert.deepEqual(value, input); assert.equal(value.byteSize, 100);
});
test('protection must be explicitly chosen; omission never silently publishes', () => {
    rejects(link({ protection: undefined }), 'RESOURCE_INVALID_PROTECTION');
    rejects(link({ protection: false }), 'RESOURCE_INVALID_PROTECTION');
    rejects(link({ protection: 'Public' }), 'RESOURCE_INVALID_PROTECTION');
});
for (const value of ['javascript:alert(1)', 'file:///C:/private.pdf', 'data:application/pdf;base64,AAAA', 'ftp://example.invalid/a', 'https://user:secret@example.invalid/a', '//example.invalid/a', 'https://example.invalid/a b', 'https://example.invalid/\nfoo', '']) {
    test('rejects unsafe or empty public URL ' + JSON.stringify(value), () => assert.throws(() => validateContent(link({ publicUrl: value })), error => /^RESOURCE_INVALID_(URL|SOURCE)$/.test(error.code)));
}
test('long URL and invalid resource names are rejected without truncation', () => {
    rejects(link({ publicUrl: 'https://example.invalid/' + 'x'.repeat(4096) }), 'RESOURCE_INVALID_URL');
    for (const name of ['', '   ', 'x'.repeat(201), 'a\nb', 'a\u0000b', 10]) rejects(link({ name }), 'RESOURCE_INVALID_NAME');
    assert.equal(validateContent(link({ name: '  Guía de estudio  ' })).name, 'Guía de estudio');
});
test('PDFs cannot be protected using an external URL or two simultaneous sources', () => {
    rejects(link({ protection: 'protected', type: 'document' }), 'RESOURCE_PROTECTED_URL_FORBIDDEN');
    rejects(pdf({ publicUrl: 'https://example.invalid/pdf' }), 'RESOURCE_PROTECTED_URL_FORBIDDEN');
    rejects(pdf({ protection: 'public', publicUrl: 'https://example.invalid/pdf' }), 'RESOURCE_INVALID_SOURCE');
    rejects(pdf({ storageKey: null }), 'RESOURCE_INVALID_SOURCE');
});
test('blob IDs cannot contain filesystem paths, and only actual PDF document metadata is accepted', () => {
    for (const storageKey of ['../../secret', 'C:\\private.pdf', 'not-an-id', randomUUID() + '.pdf']) rejects(pdf({ storageKey }), 'RESOURCE_INVALID_ID');
    rejects(pdf({ mimeType: 'image/png' }), 'RESOURCE_PDF_REQUIRED');
    rejects(pdf({ type: 'zip' }), 'RESOURCE_PDF_REQUIRED');
    rejects(pdf({ mimeType: 'application/pdf; script=x' }), 'RESOURCE_INVALID_MIME');
    rejects(pdf({ mimeType: null }), 'RESOURCE_PDF_REQUIRED');
});
test('file size and pages use strict integers with maximum 25 MiB and 200 pages', () => {
    assert.equal(LIMITS.pdfBytes, 26214400); assert.equal(LIMITS.pdfPages, 200);
    assert.equal(validateContent(pdf({ byteSize: LIMITS.pdfBytes, pageCount: LIMITS.pdfPages })).pageCount, 200);
    for (const byteSize of [0, -1, null, '100', 1.5, Infinity, LIMITS.pdfBytes + 1]) rejects(pdf({ byteSize }), 'RESOURCE_INVALID_SIZE');
    for (const pageCount of [0, -1, null, '2', 1.5, Infinity, LIMITS.pdfPages + 1]) rejects(pdf({ pageCount }), 'RESOURCE_INVALID_PAGES');
});
test('external URL never accepts unverified local-file size or page claims', () => {
    rejects(link({ byteSize: 100 }), 'RESOURCE_INVALID_SOURCE');
    rejects(link({ pageCount: 2 }), 'RESOURCE_INVALID_SOURCE');
});
test('unsupported resource types and malformed payloads are rejected', () => {
    for (const type of ['html', 'audio', '', null]) rejects(link({ type }), 'RESOURCE_INVALID_TYPE');
    for (const value of [null, [], 'resource']) rejects(value, 'RESOURCE_INVALID_INPUT');
});
