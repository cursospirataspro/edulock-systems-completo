'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPdfRenderer } = require('../lib/pdf-renderer');
const createPdf = require('./resource-fixture.cjs');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
test('actual PDF engine inspects two pages and renders marked PNG without exposing PDF bytes', async () => {
    const renderer = createPdfRenderer(), bytes = createPdf();
    assert.equal((await renderer.inspect(bytes)).pageCount, 2);
    const clean = await renderer.render(bytes, 2);
    const marked = await renderer.render(bytes, 2, { watermark: 'QA synthetic identity / ABC123' });
    assert.equal(marked.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(marked.png.readUInt32BE(16) <= 1800 && marked.png.readUInt32BE(20) <= 1800);
    assert.notDeepEqual(clean.png, marked.png); assert.equal(marked.png.includes('%PDF-'), false);
});
test('invalid uploads, excess page count and invalid page are rejected by the actual engine', async () => {
    const renderer = createPdfRenderer();
    await assert.rejects(renderer.inspect(Buffer.from('<html>Not PDF</html>')), { code: 'PDF_INVALID' });
    await assert.rejects(renderer.inspect(Buffer.from('%PDF-1.7\nnot a pdf')), { code: 'PDF_INVALID' });
    await assert.rejects(renderer.inspect(createPdf(201)), { code: 'PDF_PAGE_LIMIT' });
    await assert.rejects(renderer.render(createPdf(), 3), { code: 'PDF_PAGE_INVALID' });
});
test('bounded child-process concurrency rejects overload and recovers for later requests', async () => {
    const renderer = createPdfRenderer({ concurrency: 1 }); const first = renderer.inspect(createPdf());
    await assert.rejects(renderer.inspect(createPdf()), { code: 'PDF_BUSY' }); await first;
    assert.equal((await renderer.inspect(createPdf())).pageCount, 2);
});

async function withChildFixture(work) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edulock-pdf-child-test-'));
    const workerFile = path.join(directory, 'one-job.cjs');
    await fs.writeFile(workerFile, `'use strict';
process.once('message', job => {
    const marker = job.bytes.toString('utf8');
    if (marker.includes('SIMULATE_CRASH')) process.exit(23);
    if (marker.includes('SIMULATE_TIMEOUT')) { setInterval(() => {}, 1000); return; }
    if (process.env.EDULOCK_PRIVATE_PDF_TEST) { process.send({ok:false,code:'PDF_INVALID'}, () => process.disconnect()); return; }
    if (marker.includes('SIMULATE_EMPTY')) { process.disconnect(); return; }
    process.send({ok:true,pageCount:2}, () => {
        if (marker.includes('SIMULATE_LATE_CRASH')) process.exit(24);
        process.disconnect();
    });
});
`, 'utf8');
    try { await work(workerFile); }
    finally { await fs.unlink(workerFile); await fs.rmdir(directory); }
}

test('abnormal child exit is an isolated PDF error and does not poison the next request', async () => {
    await withChildFixture(async workerFile => {
        const renderer = createPdfRenderer({ workerFile, concurrency: 1, timeoutMs: 5000 });
        await assert.rejects(renderer.inspect(Buffer.from('%PDF-1.7 SIMULATE_CRASH')), { code: 'PDF_PROCESS_FAILED', status: 503 });
        assert.equal((await renderer.inspect(createPdf())).pageCount, 2);
    });
});

test('success message followed by a child crash is never accepted as a successful render', async () => {
    await withChildFixture(async workerFile => {
        const renderer = createPdfRenderer({ workerFile, concurrency: 1, timeoutMs: 5000 });
        await assert.rejects(renderer.inspect(Buffer.from('%PDF-1.7 SIMULATE_LATE_CRASH')), { code: 'PDF_PROCESS_FAILED' });
        assert.equal((await renderer.inspect(createPdf())).pageCount, 2);
    });
});

test('stuck child is terminated at its deadline and the capacity recovers after exit', async () => {
    await withChildFixture(async workerFile => {
        const renderer = createPdfRenderer({ workerFile, concurrency: 1, timeoutMs: 2000 });
        await assert.rejects(renderer.inspect(Buffer.from('%PDF-1.7 SIMULATE_TIMEOUT')), { code: 'PDF_TIMEOUT', status: 422 });
        assert.equal((await renderer.inspect(createPdf())).pageCount, 2);
    });
});

test('child exit zero without a result fails closed and permits a later request', async () => {
    await withChildFixture(async workerFile => {
        const renderer = createPdfRenderer({ workerFile, concurrency: 1, timeoutMs: 5000 });
        await assert.rejects(renderer.inspect(Buffer.from('%PDF-1.7 SIMULATE_EMPTY')), { code: 'PDF_PROCESS_FAILED' });
        assert.equal((await renderer.inspect(createPdf())).pageCount, 2);
    });
});

test('PDF child cannot inherit an unrelated secret from the server environment', async () => {
    const previous = process.env.EDULOCK_PRIVATE_PDF_TEST;
    process.env.EDULOCK_PRIVATE_PDF_TEST = 'synthetic-only-do-not-forward';
    try {
        await withChildFixture(async workerFile => {
            assert.equal((await createPdfRenderer({ workerFile, timeoutMs: 5000 }).inspect(createPdf())).pageCount, 2);
        });
    } finally {
        if (previous === undefined) delete process.env.EDULOCK_PRIVATE_PDF_TEST;
        else process.env.EDULOCK_PRIVATE_PDF_TEST = previous;
    }
});
