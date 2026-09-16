(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.EdulockResources = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const MAX_PDF_BYTES = 25 * 1024 * 1024;
    const PUBLIC_TYPES = new Set(['document', 'zip', 'link', 'video']);
    const PUBLIC_TO_PROTECTED = 'Las copias descargadas y los enlaces externos que ya compartiste seguirán existiendo. La protección se aplica al PDF alojado en Edulock.';
    const PROTECTED_TO_PUBLIC = 'El PDF quedará accesible por enlace y podrá descargarse sin licencia.';

    function refreshError(message) {
        const error = new Error(message);
        error.refreshRequired = true;
        return error;
    }

    function publicUrl(value) {
        const raw = String(value || '').trim();
        let parsed;
        try { parsed = new URL(raw); } catch (_) { throw new Error('Escribe un enlace completo que empiece con https:// o http://.'); }
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error('Usa un enlace http:// o https:// sin usuario ni contraseña en la URL.');
        }
        return raw;
    }
    function pdfFile(file) {
        if (!file || typeof file.name !== 'string' || !/\.pdf$/i.test(file.name)) throw new Error('Selecciona un archivo PDF.');
        if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('El PDF está vacío o no se pudo leer.');
        if (file.size > MAX_PDF_BYTES) throw new Error('El PDF debe pesar como máximo 25 MiB.');
        return file;
    }
    function versionOf(resource) {
        if (!resource || !resource.id || !Number.isSafeInteger(resource.version) || resource.version < 1) {
            throw new Error('Actualiza la lista antes de modificar este recurso.');
        }
        return resource.version;
    }
    function resourceResult(data) {
        const item = data && data.resource;
        if (!item || !item.id || !['public', 'protected'].includes(item.protection) || !['link', 'file'].includes(item.sourceKind)) {
            throw refreshError('No se pudo confirmar el recurso guardado. Actualiza la lista antes de repetir la operación.');
        }
        try { versionOf(item); } catch (_) { throw refreshError('La respuesta no incluye la versión guardada. Actualiza la lista antes de repetir la operación.'); }
        return item;
    }
    function conversionWarning(resource, protection) {
        if (!resource || resource.protection === protection) return '';
        return protection === 'protected' ? PUBLIC_TO_PROTECTED : PROTECTED_TO_PUBLIC;
    }

    // No mutation is retried automatically: after a lost response the server may
    // already have stored the resource. Optimistic versions protect later edits.
    function createClient(options) {
        const transport = options.fetch || fetch;
        const Form = options.FormData || FormData;
        async function request(method, route, body) {
            const token = options.getToken();
            if (!token) throw new Error('Inicia sesión para gestionar recursos.');
            const init = { method, headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' };
            if (body !== undefined) {
                if (body instanceof Form) init.body = body;
                else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
            }
            let response;
            try { response = await transport(route, init); }
            catch (_) { throw refreshError(method === 'GET' ? 'No hay conexión. No se pudo cargar la lista de recursos.' : 'No se pudo confirmar la operación. Actualiza la lista antes de repetirla.'); }
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                if (response.status === 401 && options.onUnauthorized) options.onUnauthorized();
                const versionConflict = response.status === 409 && (!data?.code || data.code === 'RESOURCE_VERSION_CONFLICT');
                const error = new Error(versionConflict
                    ? 'Este recurso cambió en otra sesión. Actualiza la lista y revisa sus datos antes de guardar.'
                    : data && (data.error || data.message) || 'No se pudo completar la operación (HTTP ' + response.status + ').');
                error.status = response.status;
                error.code = data && data.code;
                error.refreshRequired = response.status === 409 || response.status >= 500;
                throw error;
            }
            if (!data || typeof data !== 'object') throw refreshError('Respuesta inesperada. Actualiza la lista antes de repetir la operación.');
            return data;
        }
        function contextValues(context) {
            if (!context || !['video', 'module'].includes(context.kind) || typeof context.id !== 'string' || !context.id) {
                throw new Error('Selecciona un video o módulo para sus recursos.');
            }
            return { targetKind: context.kind, targetId: context.id };
        }
        async function list(context) {
            const target = contextValues(context);
            const data = await request('GET', '/api/resources?targetKind=' + target.targetKind + '&targetId=' + encodeURIComponent(target.targetId));
            if (!Array.isArray(data.resources) || !Array.isArray(data.legacyDocuments)) throw new Error('La lista de recursos está incompleta. Vuelve a actualizarla.');
            return data;
        }
        async function save(context, input, existing) {
            const target = contextValues(context);
            const name = String(input.name || '').trim();
            if (!name || name.length > 200) throw new Error('Escribe un nombre de entre 1 y 200 caracteres.');
            const protection = input.protection;
            if (!['public', 'protected'].includes(protection)) throw new Error('Elige Libre o Protegido.');
            const warning = conversionWarning(existing, protection);
            if (warning && input.confirmConversion !== true) throw new Error('Confirma el cambio de acceso antes de guardar.');
            if (!existing) {
                if (input.sourceKind === 'link') {
                    if (protection !== 'public') throw new Error('Para proteger un PDF debes adjuntar su archivo. Los enlaces externos son libres.');
                    if (!PUBLIC_TYPES.has(input.type)) throw new Error('Elige un tipo de enlace válido.');
                    return resourceResult(await request('POST', '/api/resources/link', { ...target, name, type: input.type, url: publicUrl(input.url) }));
                }
                if (input.sourceKind !== 'file') throw new Error('Elige Enlace público o Archivo PDF.');
                const body = new Form();
                for (const [key, value] of Object.entries({ ...target, name, protection })) body.append(key, value);
                body.append('file', pdfFile(input.file));
                return resourceResult(await request('POST', '/api/resources/upload', body));
            }
            const expectedVersion = versionOf(existing);
            const route = '/api/resources/' + encodeURIComponent(existing.id);
            if (existing.sourceKind === 'link' && protection === 'protected') {
                // Conversion preserves the saved name; a later ordinary edit may rename it.
                if (name !== existing.name) throw new Error('Guarda el nuevo nombre antes de convertir el enlace a PDF protegido.');
                const body = new Form();
                body.append('file', pdfFile(input.file));
                body.append('protection', 'protected');
                body.append('expectedVersion', String(expectedVersion));
                return resourceResult(await request('PUT', route + '/file', body));
            }
            const patch = { name, protection, expectedVersion };
            if (existing.sourceKind === 'link') patch.url = publicUrl(input.url);
            return resourceResult(await request('PATCH', route, patch));
        }
        async function remove(resource) {
            const data = await request('DELETE', '/api/resources/' + encodeURIComponent(resource.id), { expectedVersion: versionOf(resource) });
            if (data.ok !== true && data.deleted !== true && !(data.resource && data.resource.id === resource.id)) {
                throw refreshError('No se pudo confirmar la eliminación. Actualiza la lista antes de repetirla.');
            }
            return data;
        }
        return { list, save, remove };
    }

    function createEditor(options) {
        const doc = options.document || document;
        const client = options.client || createClient(options);
        let dialog, nodes, context, resources = [], legacyDocuments = [], editing = null, deleting = null;
        let busy = false, loaded = false, generation = 0, previousFocus;

        function el(tag, attributes, text) {
            const node = doc.createElement(tag);
            if (attributes) for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function button(text, action, className) {
            const node = el('button', { type: 'button', class: className || 'er-button er-secondary' }, text);
            node.addEventListener('click', action);
            return node;
        }
        function announce(text, isError) {
            nodes.status.textContent = text;
            nodes.status.className = isError ? 'er-status er-error' : 'er-status';
        }
        function setBusy(value) {
            busy = value;
            nodes.fieldset.disabled = value || !loaded;
            for (const item of dialog.querySelectorAll('button')) item.disabled = value;
            nodes.save.disabled = value || !loaded;
            nodes.refresh.disabled = value;
            nodes.close.disabled = value;
            nodes['delete-confirm'].disabled = value || !loaded;
        }
        function build() {
            if (dialog) return;
            if (!doc.getElementById('edulock-resource-styles')) {
                const style = el('style', { id: 'edulock-resource-styles' });
                style.textContent = `
                    .er-dialog{width:min(780px,calc(100vw - 24px));max-height:92vh;margin:auto;border:1px solid var(--c-border,#444);border-radius:12px;padding:22px;background:var(--c-surface,#171717);color:var(--c-text,#f5f5f5);font:14px 'Segoe UI',sans-serif;overflow:auto}
                    .er-dialog::backdrop{background:rgba(0,0,0,.72)}
                    .er-dialog *{box-sizing:border-box}.er-dialog [hidden]{display:none!important}
                    .er-heading,.er-actions,.er-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.er-heading{justify-content:space-between}.er-heading h2{font-size:1.2rem;margin:0}.er-dialog p{margin:8px 0;line-height:1.5}.er-muted{color:var(--c-muted,#adb5c2);font-size:.83rem}
                    .er-button{padding:9px 13px;border:1px solid transparent;border-radius:6px;background:var(--c-primary,#c72b24);color:#fff;cursor:pointer;font:inherit;line-height:1.2}.er-secondary{background:transparent;border-color:var(--c-border,#555);color:inherit}.er-button:disabled{opacity:.55;cursor:wait}.er-dialog :focus-visible{outline:2px solid #67adff;outline-offset:3px}
                    .er-fieldset{border:1px solid var(--c-border,#444);border-radius:8px;padding:14px;margin-top:14px;min-width:0}.er-fieldset legend{padding:0 6px;font-weight:600}.er-field{display:grid;gap:5px;margin-bottom:12px}.er-field label{font-size:.85rem;color:inherit}.er-dialog input:not([type=checkbox]),.er-dialog select{width:100%;padding:9px;background:var(--c-surface2,#232323);border:1px solid var(--c-border,#555);border-radius:6px;color:inherit;font:inherit}.er-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.er-list{display:grid;gap:9px;margin:12px 0}.er-resource{border:1px solid var(--c-border,#444);border-radius:8px;padding:12px;overflow-wrap:anywhere}.er-resource strong{font-size:.92rem}.er-resource a{color:#7db7ff;text-decoration:underline}.er-resource .er-actions{margin-top:9px}.er-status{min-height:24px;white-space:pre-wrap;margin:12px 0;color:var(--c-success,#6edda0)}.er-error{color:var(--c-error,#ff9090)}.er-warning{padding:10px;border:1px solid #947129;border-radius:6px;color:#ffd18a;margin-bottom:12px;line-height:1.45}.er-warning label{display:flex;gap:8px;align-items:flex-start;margin-top:8px;color:inherit}.er-warning input{width:auto!important;margin-top:3px;flex:0 0 auto}.er-delete{border:1px solid #bd5f55;border-radius:7px;padding:12px;margin-top:12px}.er-legacy{margin:14px 0;border-top:1px solid var(--c-border,#444);padding-top:10px}.er-legacy summary{cursor:pointer;padding:5px 0}
                    @media(max-width:540px){.er-dialog{padding:16px}.er-columns{grid-template-columns:1fr}.er-actions .er-button{flex:1}}
                `;
                doc.head.append(style);
            }
            dialog = el('dialog', { class: 'er-dialog', 'aria-labelledby': 'er-title' });
            dialog.innerHTML = `
                <div class="er-heading"><h2 id="er-title">Recursos adjuntos</h2><button type="button" class="er-button er-secondary" data-er="close">Cerrar</button></div>
                <p class="er-muted" data-er="context"></p>
                <p>Elige el acceso de cada recurso. Los enlaces y archivos nuevos son <strong>libres</strong> hasta que tú actives su protección.</p>
                <p class="er-muted">Libre: enlace y descarga. Protegido: acceso con licencia en el reproductor de Windows o Android. En esta versión puedes proteger archivos PDF.</p>
                <p class="er-muted">Los recursos libres también pueden adjuntarse a videos sin curso. Para proteger un PDF, primero asigna su video a un curso; el acceso usará la licencia de ese curso.</p>
                <div class="er-actions"><button type="button" class="er-button er-secondary" data-er="refresh">Actualizar lista</button></div>
                <div class="er-status" data-er="status" role="status" aria-live="polite"></div>
                <div class="er-list" data-er="list"></div>
                <details class="er-legacy" data-er="legacy" hidden><summary data-er="legacy-title">Enlaces anteriores (libres)</summary><div data-er="legacy-list"></div><button type="button" class="er-button er-secondary" data-er="legacy-edit" hidden>Editar enlaces anteriores</button></details>
                <div class="er-delete" data-er="delete" hidden><p data-er="delete-text"></p><div class="er-actions"><button type="button" class="er-button" data-er="delete-confirm">Sí, eliminar recurso</button><button type="button" class="er-button er-secondary" data-er="delete-cancel">Cancelar</button></div></div>
                <form data-er="form"><fieldset class="er-fieldset" data-er="fieldset"><legend data-er="legend">Agregar recurso</legend>
                    <div class="er-field"><label for="er-name">Nombre del recurso</label><input id="er-name" data-er="name" type="text" maxlength="200" required></div>
                    <div class="er-columns"><div class="er-field" data-er="source-field"><label for="er-source">Origen</label><select id="er-source" data-er="source"><option value="link">Enlace público</option><option value="file">Archivo PDF</option></select></div>
                    <div class="er-field"><label for="er-protection">Acceso</label><select id="er-protection" data-er="protection"><option value="public">Libre: enlace y descarga</option><option value="protected">Protegido: acceso con licencia</option></select></div></div>
                    <div class="er-field" data-er="type-field"><label for="er-type">Tipo de enlace</label><select id="er-type" data-er="type"><option value="document">Documento / PDF</option><option value="zip">Archivo ZIP</option><option value="link">Otro enlace</option><option value="video">Video externo</option></select></div>
                    <div class="er-field" data-er="url-field"><label for="er-url">URL pública</label><input id="er-url" data-er="url" type="url" maxlength="2000" placeholder="https://..."><span class="er-muted">Se comparte tal como la indiques. Puedes usar enlaces a PDF, ZIP, imágenes, audio u otros materiales.</span></div>
                    <div class="er-field" data-er="file-field" hidden><label for="er-file">Archivo PDF</label><input id="er-file" data-er="file" type="file" accept=".pdf,application/pdf"><span class="er-muted" data-er="file-help">Máximo 25 MiB y 200 páginas. El servidor comprobará el archivo antes de aceptarlo.</span></div>
                    <p class="er-muted" data-er="file-current" hidden>El PDF ya está alojado. Puedes cambiar su nombre o acceso.</p>
                    <p class="er-muted" data-er="conversion-help" hidden>Para proteger un enlace externo, adjunta el PDF original. Primero guarda por separado cualquier cambio de nombre.</p>
                    <div class="er-warning" data-er="warning" hidden><p data-er="warning-text"></p><label><input data-er="confirm-conversion" type="checkbox">Entiendo y quiero cambiar el acceso de este recurso.</label></div>
                    <div class="er-actions"><button type="submit" class="er-button" data-er="save">Agregar recurso</button><button type="button" class="er-button er-secondary" data-er="cancel-edit" hidden>Cancelar edición</button></div>
                </fieldset></form>`;
            nodes = {};
            for (const item of dialog.querySelectorAll('[data-er]')) nodes[item.getAttribute('data-er')] = item;
            doc.body.append(dialog);
            nodes.close.addEventListener('click', close);
            dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
            dialog.addEventListener('close', () => { generation++; previousFocus?.focus?.(); });
            nodes.refresh.addEventListener('click', () => { resetForm(); load(); });
            nodes.source.addEventListener('change', () => { nodes.protection.value = 'public'; nodes['confirm-conversion'].checked = false; updateFields(); });
            nodes.protection.addEventListener('change', () => { nodes['confirm-conversion'].checked = false; updateFields(); });
            nodes.file.addEventListener('change', () => { if (!editing && !nodes.name.value.trim() && nodes.file.files[0]) nodes.name.value = nodes.file.files[0].name.replace(/\.pdf$/i, ''); });
            nodes['cancel-edit'].addEventListener('click', resetForm);
            nodes['delete-cancel'].addEventListener('click', () => { deleting = null; nodes.delete.hidden = true; });
            nodes['delete-confirm'].addEventListener('click', remove);
            nodes.form.addEventListener('submit', save);
            nodes['legacy-edit'].addEventListener('click', () => {
                const target = { ...context }, data = legacyDocuments.map(item => ({ ...item }));
                close(); options.editLegacy(target, data);
            });
        }
        function updateFields() {
            const sourceKind = editing ? editing.sourceKind : nodes.source.value;
            const converting = editing && sourceKind === 'link' && nodes.protection.value === 'protected';
            nodes['source-field'].hidden = Boolean(editing);
            nodes.protection.options[1].disabled = !editing && sourceKind === 'link';
            if (!editing && sourceKind === 'link') nodes.protection.value = 'public';
            const needsFile = !editing && sourceKind === 'file' || converting;
            nodes['file-field'].hidden = !needsFile;
            nodes.file.required = Boolean(needsFile);
            nodes['file-current'].hidden = !editing || sourceKind !== 'file';
            nodes['conversion-help'].hidden = !converting;
            nodes.name.readOnly = Boolean(converting);
            if (converting) nodes.name.value = editing.name;
            nodes['url-field'].hidden = sourceKind !== 'link' || Boolean(converting);
            nodes.url.required = !nodes['url-field'].hidden;
            nodes['type-field'].hidden = Boolean(editing) || sourceKind !== 'link';
            const warning = conversionWarning(editing, nodes.protection.value);
            nodes.warning.hidden = !warning;
            nodes['warning-text'].textContent = warning;
            nodes['confirm-conversion'].required = Boolean(warning);
        }
        function resetForm() {
            editing = null;
            nodes.form.reset();
            nodes.name.readOnly = false;
            nodes.source.value = 'link';
            nodes.protection.value = 'public';
            nodes.legend.textContent = 'Agregar recurso';
            nodes.save.textContent = 'Agregar recurso';
            nodes['cancel-edit'].hidden = true;
            updateFields();
        }
        function edit(resource) {
            if (busy) return;
            resetForm();
            editing = resource;
            deleting = null; nodes.delete.hidden = true;
            nodes.name.value = resource.name || '';
            nodes.protection.value = resource.protection;
            nodes.url.value = resource.sourceKind === 'link' ? resource.url || '' : '';
            nodes.legend.textContent = 'Editar recurso';
            nodes.save.textContent = 'Guardar cambios';
            nodes['cancel-edit'].hidden = false;
            updateFields();
            nodes.name.focus();
            nodes.form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        function appendLink(row, resource) {
            if (typeof resource.url !== 'string' || !resource.url) return;
            let href;
            try { href = new URL(resource.url, doc.location.origin); } catch (_) { return; }
            if (!['http:', 'https:'].includes(href.protocol) || href.username || href.password) return;
            row.append(el('a', { href: href.href, target: '_blank', rel: 'noopener noreferrer' }, resource.protection === 'protected' ? 'Abrir acceso protegido' : 'Abrir enlace libre'));
        }
        function render() {
            nodes.list.replaceChildren();
            if (!resources.length) nodes.list.append(el('p', { class: 'er-muted' }, 'Todavía no hay recursos nuevos en este video o módulo.'));
            for (const item of resources) {
                const row = el('article', { class: 'er-resource' });
                row.append(el('strong', {}, item.name || 'Recurso'));
                const details = [item.protection === 'protected' ? 'Protegido · requiere licencia' : 'Libre · enlace y descarga'];
                if (item.sourceKind === 'file') details.push('PDF');
                if (Number.isFinite(item.byteSize)) details.push((item.byteSize / 1048576).toFixed(2) + ' MiB');
                if (Number.isInteger(item.pageCount)) details.push(item.pageCount + ' páginas');
                row.append(el('p', { class: 'er-muted' }, details.join(' · ')));
                appendLink(row, item);
                const actions = el('div', { class: 'er-actions' });
                actions.append(button('Editar acceso y nombre', () => edit(item)), button('Eliminar', () => {
                    if (busy) return;
                    deleting = item;
                    nodes['delete-text'].textContent = '¿Eliminar «' + (item.name || 'Recurso') + '» de este contenido? Las copias descargadas y los enlaces externos ya compartidos no se borrarán.';
                    nodes.delete.hidden = false;
                    nodes['delete-cancel'].focus();
                }));
                row.append(actions); nodes.list.append(row);
            }
            nodes.legacy.hidden = !legacyDocuments.length;
            nodes['legacy-title'].textContent = 'Enlaces anteriores (libres): ' + legacyDocuments.length;
            nodes['legacy-list'].replaceChildren();
            for (const item of legacyDocuments) {
                const row = el('article', { class: 'er-resource' });
                row.append(el('strong', {}, item.name || 'Enlace'), el('p', { class: 'er-muted' }, 'Libre · conserva su URL original'));
                appendLink(row, { ...item, protection: 'public' });
                nodes['legacy-list'].append(row);
            }
            nodes['legacy-edit'].hidden = typeof options.editLegacy !== 'function';
            setBusy(busy);
        }
        async function load() {
            if (busy) return;
            const ticket = ++generation;
            loaded = false; setBusy(true); announce('Cargando recursos…');
            try {
                const result = await client.list(context);
                if (ticket !== generation) return;
                resources = result.resources; legacyDocuments = result.legacyDocuments;
                loaded = true; render(); announce('');
            } catch (error) { if (ticket === generation) announce(error.message, true); }
            finally { if (ticket === generation) setBusy(false); }
        }
        async function save(event) {
            event.preventDefault();
            if (busy || !loaded) return;
            if (!nodes.form.reportValidity()) return;
            const input = { name: nodes.name.value, sourceKind: nodes.source.value, protection: nodes.protection.value,
                type: nodes.type.value, url: nodes.url.value, file: nodes.file.files[0], confirmConversion: nodes['confirm-conversion'].checked };
            const ticket = ++generation;
            setBusy(true); announce(input.file ? 'Enviando y comprobando el PDF…' : 'Guardando recurso…');
            try {
                const saved = await client.save(context, input, editing);
                if (ticket !== generation) return;
                const index = resources.findIndex(item => item.id === saved.id);
                if (index >= 0) resources[index] = saved; else resources.push(saved);
                resetForm(); render(); announce('Recurso guardado como ' + (saved.protection === 'protected' ? 'Protegido.' : 'Libre.'));
            } catch (error) { if (ticket === generation) { if (error.refreshRequired) loaded = false; announce(error.message, true); } }
            finally { if (ticket === generation) setBusy(false); }
        }
        async function remove() {
            if (busy || !deleting) return;
            const target = deleting;
            const ticket = ++generation;
            setBusy(true); announce('Eliminando recurso…');
            try {
                await client.remove(target);
                if (ticket !== generation) return;
                resources = resources.filter(item => item.id !== target.id);
                deleting = null; nodes.delete.hidden = true;
                if (editing && editing.id === target.id) resetForm();
                render(); announce('Recurso eliminado.');
            } catch (error) { if (ticket === generation) { if (error.refreshRequired) loaded = false; announce(error.message, true); } }
            finally { if (ticket === generation) setBusy(false); }
        }
        async function open(target) {
            build();
            if (busy || dialog.open) return;
            previousFocus = doc.activeElement;
            context = { ...target }; resources = []; legacyDocuments = [];
            loaded = false; deleting = null;
            nodes.delete.hidden = true;
            nodes.context.textContent = (target.kind === 'module' ? 'Módulo: ' : 'Video: ') + (target.title || '');
            resetForm(); render();
            try { dialog.showModal(); }
            catch (_) { options.onError?.('No se pudo abrir el editor de recursos. Actualiza el panel y vuelve a intentarlo.'); return; }
            await load();
        }
        function close() { if (dialog && !busy) dialog.close(); }
        function invalidate() {
            generation++;
            if (!dialog) return;
            loaded = false; resources = []; legacyDocuments = []; context = null; deleting = null;
            setBusy(false); resetForm(); render(); announce('');
            nodes.context.textContent = ''; nodes.delete.hidden = true;
            if (dialog.open) dialog.close();
        }
        return { open, close, invalidate };
    }
    return { createClient, createEditor, publicUrl, pdfFile, conversionWarning, MAX_PDF_BYTES };
});
