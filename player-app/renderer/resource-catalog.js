'use strict';
(() => {
    const api = window.vcbPlayer;
    const panel = document.getElementById('resources-panel'), content = document.getElementById('resources-list'), status = document.getElementById('resources-status');
    let epoch = 0;
    function close() { epoch++; panel.hidden = true; content.replaceChildren(); status.textContent = ''; }
    function documentRow(doc, target, location) {
        if (!doc || typeof doc !== 'object') return;
        const protectedDoc = doc.protection === 'protected';
        const id = doc.resourceId || doc.id;
        if (!protectedDoc && !doc.url) return;
        const row = document.createElement('div'); row.className = 'resource-row';
        const text = document.createElement('div'), title = document.createElement('strong'), description = document.createElement('small');
        title.textContent = String(doc.name || doc.title || 'Material');
        description.textContent = location + ' · ' + (protectedDoc ? 'PDF protegido' : 'Enlace público · permite descargar');
        text.append(title, description);
        const open = document.createElement('button'); open.type = 'button'; open.textContent = protectedDoc ? 'Leer protegido' : 'Abrir enlace';
        open.addEventListener('click', async () => {
            const current = epoch; open.disabled = true; status.textContent = protectedDoc ? 'Autorizando documento…' : 'Abriendo enlace…';
            try {
                const response = protectedDoc ? await api.openResource(id) : await api.openPublicResource(doc.url);
                if (current === epoch) status.textContent = response?.ok ? '' : response?.error || 'No se pudo abrir el material.';
            } catch { if (current === epoch) status.textContent = 'No se pudo abrir el material. Vuelve a intentarlo.'; }
            finally { open.disabled = false; }
        });
        row.append(text, open); target.appendChild(row);
    }
    function walk(node, target, location, depth = 0) {
        if (!node || depth > 20) return;
        for (const doc of Array.isArray(node.documents) ? node.documents : []) documentRow(doc, target, location);
        for (const video of Array.isArray(node.videos) ? node.videos : []) walk(video, target, location + ' / ' + (video.title || 'Clase'), depth + 1);
        for (const child of [...(Array.isArray(node.modules) ? node.modules : []), ...(Array.isArray(node.children) ? node.children : [])])
            walk(child, target, location + ' / ' + (child.name || 'Módulo'), depth + 1);
    }
    async function load() {
        const current = ++epoch; panel.hidden = false; content.replaceChildren(); status.textContent = 'Cargando materiales…';
        try {
            const response = await api.getResourceCatalog();
            if (current !== epoch) return;
            if (!response?.ok || !Array.isArray(response.catalog?.courses)) { status.textContent = response?.error || 'No se pudieron cargar los materiales.'; return; }
            for (const course of response.catalog.courses) {
                const section = document.createElement('section'), title = document.createElement('h3'); title.textContent = course.name || 'Curso';
                section.appendChild(title); walk(course, section, course.name || 'Curso');
                if (section.children.length > 1) content.appendChild(section);
            }
            status.textContent = content.children.length ? '' : 'Todavía no tienes materiales adjuntos disponibles. Los videos se abren desde los enlaces de tus clases.';
        } catch { if (current === epoch) status.textContent = 'No se pudieron cargar los materiales. Comprueba la conexión y vuelve a intentarlo.'; }
    }
    document.getElementById('btn-resources').addEventListener('click', () => void load());
    document.getElementById('resources-close').addEventListener('click', close);
    document.getElementById('resources-refresh').addEventListener('click', () => void load());
    api.onSecurityBlocked(close); api.onStopPlayback(close); api.onLicenseRegenerated(close);
    window.addEventListener('beforeunload', close);
})();
