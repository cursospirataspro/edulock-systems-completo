'use strict';
(() => {
    const api = window.edulockDocument, $ = id => document.getElementById(id);
    const canvas = $('page'), context = canvas.getContext('2d', { alpha: false });
    let descriptor = null, page = 1, sequence = 0, image = null, deadline = 0, closed = false, loading = false;
    function clear() {
        sequence++;
        if (image) { image.onload = image.onerror = null; image.src = ''; image = null; }
        context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = canvas.height = 0;
    }
    function fail(message) {
        clear(); closed = true; descriptor = null; deadline = 0;
        $('watermarks').replaceChildren(); $('identity').textContent = '';
        $('status').textContent = message || 'El documento se cerró. Vuelve a abrirlo.';
        $('previous').disabled = $('next').disabled = $('zoom').disabled = true;
    }
    function valid() { return !closed && descriptor && performance.now() < deadline; }
    function controls() {
        $('previous').disabled = loading || page <= 1 || !valid();
        $('next').disabled = loading || page >= (descriptor?.resource.pageCount || 0) || !valid();
        $('page-label').textContent = 'Página ' + page + ' de ' + (descriptor?.resource.pageCount || 0);
    }
    function zoom() { $('paper').style.width = Math.round(Math.min(860, window.innerWidth - 65) * Number($('zoom').value)) + 'px'; }
    async function load(number) {
        if (!valid()) return fail('La autorización venció. Vuelve a abrir el documento con conexión.');
        clear(); const request = sequence; loading = true; controls(); $('status').textContent = 'Cargando página…';
        try {
            const response = await api.page(number);
            if (request !== sequence || !valid()) return;
            if (!response?.ok || response.version !== descriptor.resource.version || response.page !== number
                || typeof response.png !== 'string' || response.png.length > 17 * 1024 * 1024)
                return fail(response?.error || 'No se pudo autorizar esta página.');
            const current = new Image(); image = current;
            current.onload = () => {
                if (request !== sequence || !valid() || image !== current) { current.src = ''; return; }
                canvas.width = current.naturalWidth; canvas.height = current.naturalHeight;
                context.drawImage(current, 0, 0); current.onload = current.onerror = null; current.src = ''; image = null;
                page = number; loading = false; controls(); zoom(); $('status').textContent = '';
            };
            current.onerror = () => { if (request === sequence) fail('No se pudo mostrar la página. Vuelve a abrir el documento.'); };
            current.src = 'data:image/png;base64,' + response.png;
            response.png = '';
        } catch { if (request === sequence) fail('Se interrumpió la conexión. Vuelve a abrir el documento.'); }
    }
    $('previous').addEventListener('click', () => { if (!loading && page > 1) void load(page - 1); });
    $('next').addEventListener('click', () => { if (!loading && descriptor && page < descriptor.resource.pageCount) void load(page + 1); });
    $('zoom').addEventListener('change', zoom); window.addEventListener('resize', zoom);
    $('close').addEventListener('click', () => { fail(); api.close(); });
    document.addEventListener('contextmenu', event => event.preventDefault());
    for (const type of ['copy', 'cut', 'dragstart', 'drop']) document.addEventListener(type, event => event.preventDefault());
    window.addEventListener('beforeunload', () => fail());
    api.onInvalidate(fail);
    api.onLease(milliseconds => {
        if (!valid() || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 30000) return fail('La autorización venció.');
        deadline = performance.now() + milliseconds;
    });
    setInterval(() => { if (descriptor && !valid()) { fail('La autorización venció. Vuelve a abrir el documento con conexión.'); api.close(); } }, 200);
    (async () => {
        try {
            const started = performance.now();
            const response = await api.descriptor();
            if (closed) return;
            if (!response?.ok || !Number.isFinite(response.leaseRemainingMs) || response.leaseRemainingMs <= 0 || response.leaseRemainingMs > 30000)
                return fail(response?.error || 'No se pudo autorizar el documento.');
            descriptor = response; deadline = started + response.leaseRemainingMs;
            $('document-name').textContent = response.resource.name;
            const identity = response.watermark.email + ' · ' + response.watermark.code;
            $('identity').textContent = identity;
            for (let index = 0; index < 8; index++) {
                const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = identity; $('watermarks').appendChild(mark);
            }
            await load(1);
        } catch { fail('No se pudo iniciar el visor protegido.'); }
    })();
})();
