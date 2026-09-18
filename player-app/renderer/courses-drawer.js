'use strict';
// ── "Mis Cursos" — capa opcional de navegación dentro del reproductor ────────
// Solo aparece cuando el servidor responde embeddedCatalogEnabled:true para la sesión
// actual (interruptor del productor, decidido en el servidor). Con false, este archivo
// no muestra nada y el reproductor se comporta exactamente como siempre: los enlaces de
// clase, /cover/ y edulock:// siguen siendo el camino habitual y no cambian.
//
// El árbol se pinta con createElement/textContent (nunca innerHTML con datos del servidor)
// y la reproducción se pide a player.js con un evento; toda la autorización la repite el
// servidor en /api/resolve-direct.
(() => {
    const api = window.vcbPlayer;
    const button = document.getElementById('btn-courses');
    const drawer = document.getElementById('courses-drawer');
    const backdrop = document.getElementById('courses-backdrop');
    const tree = document.getElementById('courses-tree');
    const status = document.getElementById('courses-status');
    const materialsButton = document.getElementById('btn-resources');
    if (!api || !button || !drawer || !tree || !status) return;

    let epoch = 0;                 // descarta respuestas de cargas anteriores
    let enabled = false;           // último valor confirmado por el servidor
    let currentVideoId = '';
    const expanded = new Set();    // nodos desplegados (se conserva entre refrescos)

    const setStatus = text => { status.textContent = text || ''; };

    function showMaterialsButton(show) {
        // Con "Mis Cursos" activo los materiales viven dentro del panel; el botón antiguo
        // solo se oculta, nunca se elimina, y vuelve en cuanto el interruptor se apaga.
        if (materialsButton) materialsButton.style.display = show ? '' : 'none';
    }

    function applyEnabled(value) {
        enabled = value === true;
        button.hidden = !enabled;
        button.classList.toggle('available', enabled);
        showMaterialsButton(!enabled);
        if (!enabled) close();
    }

    function close() {
        epoch++;
        drawer.hidden = true;
        backdrop.hidden = true;
        tree.replaceChildren();
        setStatus('');
    }

    function clear() {
        close();                       // close() ya adelanta la generacion
        expanded.clear();
        currentVideoId = '';
        cancelProbe();                 // una consulta en vuelo no puede reabrir nada
        applyEnabled(false);
    }

    // ── Consulta silenciosa del interruptor ───────────────────────────────────
    // Tiene el mismo control de generacion que la carga: una respuesta que llega
    // tarde, despues de cerrar sesion, cambiar de cuenta o revocar la licencia, se
    // descarta en vez de volver a encender el boton (F09).
    let probeEpoch = 0;
    let probeTimer = null;
    let probeRunning = false;

    function cancelProbe() {
        probeEpoch++;
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    }

    // ── Construcción del árbol ────────────────────────────────────────────────
    function keyOf(kind, id) { return kind + ':' + id; }

    function classRow(video) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ct-item';
        const mark = document.createElement('span');
        mark.className = 'ct-mark';
        mark.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = String(video.title || 'Clase');
        row.append(mark, label);
        const id = typeof video.videoId === 'string' ? video.videoId : '';
        row.dataset.videoId = id;
        const current = id && id === currentVideoId;
        mark.textContent = current ? '▶' : '▷';
        row.classList.toggle('ct-current', !!current);
        if (current) row.setAttribute('aria-current', 'true');
        row.addEventListener('click', () => {
            if (!id) return;
            currentVideoId = id;
            markCurrent();
            setStatus('Abriendo «' + String(video.title || 'Clase') + '»…');
            // player.js vuelve a pedir autorización al servidor antes de reproducir.
            document.dispatchEvent(new CustomEvent('edulock:play-video', { detail: { videoId: id } }));
        });
        return row;
    }

    function documentRow(doc) {
        if (!doc || typeof doc !== 'object') return null;
        const protectedDoc = doc.protection === 'protected';
        const id = doc.resourceId || doc.id;
        if (!protectedDoc && !doc.url) return null;
        if (protectedDoc && !id) return null;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ct-item ct-doc';
        const mark = document.createElement('span');
        mark.className = 'ct-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = protectedDoc ? '▤' : '□';
        const label = document.createElement('span');
        label.textContent = String(doc.name || doc.title || 'Material')
            + (protectedDoc ? ' · PDF protegido' : ' · enlace');
        row.append(mark, label);
        row.addEventListener('click', async () => {
            const current = epoch;
            row.disabled = true;
            setStatus(protectedDoc ? 'Autorizando documento…' : 'Abriendo enlace…');
            try {
                // Mismo sistema de recursos de siempre: el PDF protegido nunca sale del visor.
                const response = protectedDoc ? await api.openResource(id) : await api.openPublicResource(doc.url);
                if (current === epoch) setStatus(response && response.ok ? '' : (response && response.error) || 'No se pudo abrir el material.');
            } catch {
                if (current === epoch) setStatus('No se pudo abrir el material. Vuelve a intentarlo.');
            } finally { row.disabled = false; }
        });
        return row;
    }

    function collapsible(kind, id, title, className) {
        const node = document.createElement('div');
        node.className = 'ct-node ' + className;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ct-toggle';
        const caret = document.createElement('span');
        caret.className = 'ct-caret';
        caret.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = String(title || '');
        toggle.append(caret, label);
        const children = document.createElement('div');
        children.className = 'ct-children';
        const key = keyOf(kind, id);
        const paint = () => {
            const open = expanded.has(key);
            caret.textContent = open ? '▼' : '▶';
            children.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
        };
        toggle.addEventListener('click', () => {
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            paint();
        });
        paint();
        node.append(toggle, children);
        return { node, children };
    }

    function fillModule(module, target, depth) {
        if (!module || depth > 20) return;
        const { node, children } = collapsible('module', module.id, module.name || 'Módulo', 'ct-module');
        let count = 0;
        for (const doc of Array.isArray(module.documents) ? module.documents : []) {
            const row = documentRow(doc);
            if (row) { children.appendChild(row); count++; }
        }
        for (const video of Array.isArray(module.videos) ? module.videos : []) {
            children.appendChild(classRow(video));
            count++;
            for (const doc of Array.isArray(video.documents) ? video.documents : []) {
                const row = documentRow(doc);
                if (row) { children.appendChild(row); count++; }
            }
        }
        for (const child of Array.isArray(module.children) ? module.children : []) count += fillModule(child, children, depth + 1) ? 1 : 0;
        if (!count) {
            const empty = document.createElement('p');
            empty.className = 'ct-empty';
            empty.textContent = 'Sin clases todavía.';
            children.appendChild(empty);
        }
        target.appendChild(node);
        return true;
    }

    function render(courses) {
        tree.replaceChildren();
        let total = 0;
        for (const course of courses) {
            const { node, children } = collapsible('course', course.id, course.name || 'Curso', 'ct-course');
            if (!expanded.has(keyOf('course', course.id)) && courses.length === 1) {
                expanded.add(keyOf('course', course.id));
                children.hidden = false;
                node.querySelector('.ct-caret').textContent = '▼';
                node.querySelector('.ct-toggle').setAttribute('aria-expanded', 'true');
            }
            for (const doc of Array.isArray(course.documents) ? course.documents : []) {
                const row = documentRow(doc);
                if (row) children.appendChild(row);
            }
            for (const video of Array.isArray(course.videos) ? course.videos : []) {
                children.appendChild(classRow(video));
                for (const doc of Array.isArray(video.documents) ? video.documents : []) {
                    const row = documentRow(doc);
                    if (row) children.appendChild(row);
                }
            }
            for (const module of Array.isArray(course.modules) ? course.modules : []) fillModule(module, children, 0);
            tree.appendChild(node);
            total++;
        }
        return total;
    }

    function markCurrent() {
        for (const row of tree.querySelectorAll('.ct-item[data-video-id]')) {
            const current = row.dataset.videoId && row.dataset.videoId === currentVideoId;
            row.classList.toggle('ct-current', !!current);
            const mark = row.querySelector('.ct-mark');
            if (mark) mark.textContent = current ? '▶' : '▷';
            if (current) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
        }
    }

    // ── Carga del catálogo ────────────────────────────────────────────────────
    // El interruptor y el contenido se vuelven a consultar cada vez: una lista cargada
    // antes no autoriza nada, y la autorización real la hace el servidor al reproducir.
    async function load({ open = true } = {}) {
        const current = ++epoch;
        if (open) { drawer.hidden = false; backdrop.hidden = false; }
        tree.replaceChildren();
        setStatus('Cargando tus cursos…');
        let response;
        try { response = await api.getResourceCatalog(); }
        catch { if (current === epoch) setStatus('No se pudo conectar con el servidor. Comprueba tu conexión y vuelve a intentarlo.'); return; }
        if (current !== epoch) return;
        if (!response || !response.ok) {
            const code = response && response.code;
            if (code === 'SESSION_ENDED' || code === 'AUTH_REQUIRED') setStatus('Tu sesión terminó. Vuelve a iniciar sesión e ingresa tu licencia.');
            else if (code === 'LICENSE_REQUIRED') setStatus('Ingresa la licencia de tu curso para ver tus clases.');
            else setStatus((response && response.error) || 'No se pudieron cargar tus cursos.');
            return;
        }
        const catalog = response.catalog || {};
        applyEnabled(catalog.embeddedCatalogEnabled === true);
        if (!enabled) return;
        if (catalog.requiresLicense === true) { setStatus('Ingresa la licencia de tu curso para ver tus clases.'); return; }
        const courses = Array.isArray(catalog.courses) ? catalog.courses : [];
        const total = render(courses);
        markCurrent();
        setStatus(total ? '' : 'Todavía no hay clases publicadas en tu curso.');
    }

    // ── Apertura y cierre ─────────────────────────────────────────────────────
    button.addEventListener('click', () => {
        if (!enabled) return;
        if (!drawer.hidden) { close(); return; }
        void load({ open: true });
    });
    document.getElementById('courses-close').addEventListener('click', close);
    document.getElementById('courses-refresh').addEventListener('click', () => { if (enabled) void load({ open: true }); });
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', event => {
        // Escape cierra el panel solo si está abierto; en pantalla completa el reproductor
        // conserva su propio comportamiento porque el evento no se cancela cuando está cerrado.
        if (event.key === 'Escape' && !drawer.hidden) { close(); event.stopPropagation(); }
    }, true);

    document.addEventListener('edulock:video-changed', event => {
        currentVideoId = (event && event.detail && event.detail.videoId) || '';
        markCurrent();
        if (!drawer.hidden) setStatus('');
    });

    // Cierre de sesión, bloqueo de seguridad o licencia regenerada: nada del alumno
    // anterior puede quedar visible ni cargándose.
    const logoutButton = document.getElementById('btn-logout');
    if (logoutButton) logoutButton.addEventListener('click', clear);
    api.onSecurityBlocked(close);
    api.onStopPlayback(clear);
    api.onLicenseRegenerated(clear);
    window.addEventListener('beforeunload', clear);

    // Consulta silenciosa al arrancar: si el productor no lo habilito, el boton ni aparece.
    scheduleProbe(1200);

    /** Programa una consulta unica; nunca deja dos en cola ni dos en vuelo. */
    function scheduleProbe(delay) {
        if (probeTimer) clearTimeout(probeTimer);
        const mine = ++probeEpoch;
        probeTimer = setTimeout(() => { probeTimer = null; void probe(mine, 0); }, delay);
    }

    /**
     * `attempt` cuenta los intentos ya gastados. Un fallo de conexion se reintenta
     * un maximo de tres veces con esperas crecientes; agotados los intentos se deja
     * el boton apagado hasta el proximo cambio de sesion. Nunca hay bucle.
     */
    async function probe(generation, attempt) {
        if (generation !== probeEpoch || probeRunning) return;
        probeRunning = true;
        let response = null, failed = false;
        try { response = await api.getResourceCatalog(); }
        catch { failed = true; }
        finally { probeRunning = false; }
        // La sesion cambio mientras esperabamos: esta respuesta ya no dice nada.
        if (generation !== probeEpoch) return;
        if (failed) {
            if (attempt < 3) {
                const espera = 2000 * Math.pow(2, attempt);
                probeTimer = setTimeout(() => { probeTimer = null; void probe(generation, attempt + 1); }, espera);
            } else applyEnabled(false);
            return;
        }
        applyEnabled(!!response && response.ok && response.catalog && response.catalog.embeddedCatalogEnabled === true);
    }

    // Al cambiar la sesion (entrar, activar licencia o recibir una nueva) se vuelve
    // a preguntar, en vez de quedarse con lo que se supo al arrancar.
    document.addEventListener('edulock:session-changed', () => { cancelProbe(); scheduleProbe(300); });
})();
