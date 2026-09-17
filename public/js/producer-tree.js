/* Árbol de contenido del productor: módulos, submódulos y clases.
 * Funciones puras (jerarquía, orden, validaciones) + vista DOM con arrastre por puntero (ratón y táctil)
 * y alternativa por teclado. No conoce la API: recibe callbacks. UMD para poder probarse en Node. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EdulockTree = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const byOrder = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id || a.videoId).localeCompare(String(b.id || b.videoId));

  /** Construye la jerarquía. Módulos con padre inexistente se tratan como raíz (nunca se pierden). */
  function buildTree(modules = [], videos = []) {
    const ids = new Set(modules.map(m => m.id));
    const nodes = new Map(modules.map(m => [m.id, { module: m, children: [], videos: [] }]));
    const roots = [];
    for (const m of [...modules].sort(byOrder)) {
      const node = nodes.get(m.id);
      if (m.parentId && ids.has(m.parentId) && m.parentId !== m.id) nodes.get(m.parentId).children.push(node);
      else roots.push(node);
    }
    const orphans = [];
    for (const v of [...videos].sort(byOrder)) {
      if (v.moduleId && nodes.has(v.moduleId)) nodes.get(v.moduleId).videos.push(v); else orphans.push(v);
    }
    // Un ciclo en datos antiguos (A dentro de B dentro de A) dejaría nodos fuera de las raíces: se recuperan.
    const seen = new Set();
    const walk = node => { if (seen.has(node.module.id)) return; seen.add(node.module.id); node.children.forEach(walk); };
    roots.forEach(walk);
    for (const node of nodes.values()) if (!seen.has(node.module.id)) {
      // Rompe el ciclo en este eslabón: el nodo pasa a raíz y deja de colgar de su padre.
      const parent = nodes.get(node.module.parentId);
      if (parent) parent.children = parent.children.filter(child => child !== node);
      roots.push(node); walk(node);
    }
    return { roots, orphans, nodes };
  }
  function descendantIds(modules, id) {
    const out = new Set(); const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      for (const m of modules) if (m.parentId === current && !out.has(m.id)) { out.add(m.id); stack.push(m.id); }
    }
    return out;
  }
  /** Un módulo no puede quedar dentro de sí mismo ni de un descendiente. */
  function canReparent(modules, id, parentId) {
    if (!parentId) return true;
    if (parentId === id) return false;
    if (!modules.some(m => m.id === parentId)) return false;
    return !descendantIds(modules, id).has(parentId);
  }
  /** Clases de un módulo contando sus submódulos (criterio único en toda la interfaz). */
  function countClasses(node) { return node.videos.length + node.children.reduce((sum, child) => sum + countClasses(child), 0); }
  /** Mueve un elemento de una posición a otra dentro de la misma lista y devuelve los ids resultantes. */
  function moveWithin(items, fromIndex, toIndex) {
    const ids = items.map(x => x.id || x.videoId);
    if (fromIndex < 0 || fromIndex >= ids.length || toIndex < 0 || toIndex >= ids.length || fromIndex === toIndex) return null;
    const [moved] = ids.splice(fromIndex, 1); ids.splice(toIndex, 0, moved);
    return ids;
  }
  const statusInfo = { ready: ['Listo', 'good'], processing: ['Procesando', 'wait'], uploading: ['Enviando', 'wait'], pending: ['Pendiente', 'wait'], error: ['Error', 'bad'], failed: ['Error', 'bad'], deleted: ['Eliminado', 'bad'] };
  function statusLabel(status) { return statusInfo[status] || [status || 'Pendiente', 'wait']; }

  /**
   * Vista DOM. `actions` recibe: newClass(module), newSubmodule(module), moduleMenu(module, anchor), classMenu(video, anchor),
   * classLink(video, button), toggle(moduleId, open), reorder({kind, container, ids, revert}), moveClass(video, moduleId, revert).
   */
  function createTreeView({ container, document: doc, actions, esc }) {
    const html = value => esc(value == null ? '' : String(value));
    let openState = new Set(), dragging = null, lastTree = null;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const btn = (text, cls, fn, title) => { const b = el('button', 'btn ' + cls, text); b.type = 'button'; b.title = title || text; b.setAttribute('aria-label', title || text); b.addEventListener('click', event => { event.stopPropagation(); fn(b); }); return b; };

    function classRow(video, listNode) {
      const row = el('li', 'tree-row tree-class'); row.dataset.videoId = video.videoId; row.dataset.kind = 'video';
      const [label, tone] = statusLabel(video.status);
      row.innerHTML = '<span class="tree-grip" tabindex="0" role="button" aria-label="Arrastrar para ordenar (Alt+↑/↓ con teclado)"></span><span class="tree-icon video" aria-hidden="true">▶</span><span class="tree-title"></span><span class="pill ' + tone + '">' + html(label) + '</span>' + (video.attachments ? '<span class="tree-badge" title="' + html(video.attachments) + ' adjunto(s)">📎 ' + html(video.attachments) + '</span>' : '') + (video.collectionSyncPending ? '<span class="tree-badge warn" title="Colección de video pendiente de sincronizar">Sincronización pendiente</span>' : '');
      row.querySelector('.tree-title').textContent = video.title || 'Clase';
      const acts = el('div', 'tree-actions');
      acts.append(btn('Enlace', 'ghost small', b => actions.classLink(video, b), video.status === 'ready' ? 'Enlace de la clase' : 'Disponible cuando la clase esté lista'));
      acts.lastChild.disabled = video.status !== 'ready';
      acts.append(btn('⋯', 'ghost small tree-menu', b => actions.classMenu(video, b), 'Más acciones de la clase'));
      row.append(acts);
      wireDrag(row, listNode, 'video');
      return row;
    }
    function moduleRow(node, depth) {
      const m = node.module, open = openState.has(m.id);
      const li = el('li', 'tree-node depth-' + Math.min(depth, 4)); li.dataset.moduleId = m.id;
      const row = el('div', 'tree-row tree-module'); row.dataset.moduleId = m.id; row.dataset.kind = 'module';
      const count = countClasses(node);
      row.innerHTML = '<span class="tree-grip" tabindex="0" role="button" aria-label="Arrastrar para ordenar (Alt+↑/↓ con teclado)"></span><button type="button" class="tree-toggle" aria-expanded="' + open + '" aria-label="' + (open ? 'Contraer' : 'Expandir') + '"></button><span class="tree-icon module" aria-hidden="true">' + (depth ? '▸' : '▣') + '</span><span class="tree-title"></span><span class="muted tree-count" title="Incluye las clases de sus submódulos">' + html(count) + ' clase' + (count === 1 ? '' : 's') + '</span>' + (m.attachments ? '<span class="tree-badge" title="' + html(m.attachments) + ' recurso(s) del módulo">📎 ' + html(m.attachments) + '</span>' : '') + (m.playlistUrl ? '<span class="tree-badge" title="Lista publicada">Lista</span>' : '');
      row.querySelector('.tree-title').textContent = m.name;
      row.querySelector('.tree-toggle').addEventListener('click', event => { event.stopPropagation(); toggle(m.id); });
      const acts = el('div', 'tree-actions');
      acts.append(btn('+ Clase', 'ghost small', () => actions.newClass(m), 'Agregar una clase a ' + m.name));
      acts.append(btn('Submódulo', 'ghost small', () => actions.newSubmodule(m), 'Crear un submódulo dentro de ' + m.name));
      acts.append(btn('⋯', 'ghost small tree-menu', b => actions.moduleMenu(m, b), 'Más acciones del módulo'));
      row.append(acts);
      li.append(row);
      const body = el('div', 'tree-body'); body.hidden = !open;
      const classes = el('ul', 'tree-list tree-classes'); classes.dataset.moduleId = m.id; classes.dataset.listKind = 'video';
      if (!node.videos.length) classes.append(el('li', 'tree-empty muted', node.children.length ? 'Sin clases directas en este módulo. Arrastra una clase aquí o usa «+ Clase».' : 'Sin clases todavía. Usa «+ Clase» o arrastra una clase hasta aquí.'));
      for (const v of node.videos) classes.append(classRow(v, classes));
      body.append(classes);
      const children = el('ul', 'tree-list tree-children'); children.dataset.parentId = m.id; children.dataset.listKind = 'module';
      for (const child of node.children) children.append(moduleRow(child, depth + 1));
      body.append(children);
      li.append(body);
      wireDrag(row, null, 'module');
      return li;
    }
    function toggle(id, force) {
      const open = force === undefined ? !openState.has(id) : force;
      if (open) openState.add(id); else openState.delete(id);
      const li = container.querySelector('li.tree-node[data-module-id="' + CSS.escape(id) + '"]');
      if (li) { const body = li.querySelector(':scope > .tree-body'), t = li.querySelector(':scope > .tree-row .tree-toggle'); body.hidden = !open; t.setAttribute('aria-expanded', String(open)); t.setAttribute('aria-label', open ? 'Contraer' : 'Expandir'); }
      if (actions.toggle) actions.toggle(id, open);
    }

    /* ── Arrastre por puntero: funciona con ratón y táctil; reordena hermanos y traslada clases entre módulos. */
    function wireDrag(row, listNode, kind) {
      const grip = row.querySelector('.tree-grip');
      grip.addEventListener('pointerdown', event => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        startDrag(row, kind, event);
      });
      grip.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const list = row.closest('ul.tree-list'), items = siblings(list, kind), index = items.indexOf(kind === 'video' ? row : row.closest('li.tree-node'));
        const target = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (index < 0 || target < 0 || target >= items.length) return;
        commitOrder(list, kind, index, target).then(() => { const again = container.querySelector((kind === 'video' ? '.tree-class[data-video-id="' + CSS.escape(row.dataset.videoId) : 'li.tree-node[data-module-id="' + CSS.escape(row.dataset.moduleId)) + '"] .tree-grip'); again?.focus(); });
      });
    }
    const siblings = (list, kind) => Array.from(list.children).filter(n => kind === 'video' ? n.classList.contains('tree-class') : n.classList.contains('tree-node'));
    function startDrag(row, kind, event) {
      const item = kind === 'video' ? row : row.closest('li.tree-node');
      const list = item.parentElement;
      const ghost = row.cloneNode(true); ghost.classList.add('tree-ghost'); ghost.style.width = row.getBoundingClientRect().width + 'px';
      doc.body.append(ghost);
      dragging = { row, item, kind, list, ghost, from: siblings(list, kind).indexOf(item), placeholder: el('li', 'tree-placeholder'), targetList: list, targetIndex: null };
      container.classList.add('is-dragging');
      item.classList.add('is-dragged');
      const move = e => { positionGhost(e); updateTarget(e); };
      const up = e => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', up); doc.removeEventListener('pointercancel', cancel); finishDrag(e); };
      const cancel = () => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', up); doc.removeEventListener('pointercancel', cancel); cleanupDrag(); };
      doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', up); doc.addEventListener('pointercancel', cancel);
      positionGhost(event);
    }
    function positionGhost(e) { if (!dragging) return; dragging.ghost.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY - 16) + 'px)'; }
    function updateTarget(e) {
      if (!dragging) return;
      dragging.ghost.style.pointerEvents = 'none';
      const under = doc.elementFromPoint(e.clientX, e.clientY);
      if (!under || !container.contains(under)) return;
      if (under.closest('.tree-placeholder')) return; // sobre el marcador: se conserva la posición actual
      const { kind } = dragging;
      const isSibling = n => n !== dragging.item && (kind === 'video' ? n.classList.contains('tree-class') : n.classList.contains('tree-node'));
      // Sin fila debajo del puntero: la posición se decide por el punto medio de cada hermano.
      const byMidpoint = list => Array.from(list.children).filter(isSibling).find(n => e.clientY < n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2) || null;
      let list = null, before = null;
      if (kind === 'video') {
        const overClass = under.closest('.tree-class');
        const overModuleRow = under.closest('.tree-row.tree-module');
        const overList = under.closest('ul.tree-classes') || under.closest('ul.tree-orphans') || (overModuleRow && overModuleRow.closest('li.tree-node')?.querySelector(':scope > .tree-body > ul.tree-classes'));
        if (overClass && overClass !== dragging.item) { list = overClass.parentElement; const rect = overClass.getBoundingClientRect(); before = e.clientY < rect.top + rect.height / 2 ? overClass : overClass.nextElementSibling; }
        else if (overList) { list = overList; before = overModuleRow ? Array.from(list.children).find(isSibling) || null : byMidpoint(list); }
      } else {
        const overNode = under.closest('li.tree-node');
        if (overNode && overNode !== dragging.item && !dragging.item.contains(overNode) && overNode.parentElement === dragging.list) {
          const row = overNode.querySelector(':scope > .tree-row'); const rect = row.getBoundingClientRect();
          list = dragging.list; before = e.clientY < rect.top + rect.height / 2 ? overNode : overNode.nextElementSibling;
        } else if (under.closest('ul.tree-list') === dragging.list) { list = dragging.list; before = byMidpoint(list); }
      }
      if (!list) return;
      if (before === dragging.item) before = dragging.item.nextElementSibling;
      // El módulo de destino se despliega para que el marcador sea visible.
      const body = list.closest('.tree-body'); if (body && body.hidden) { const id = body.parentElement?.dataset.moduleId; if (id) toggle(id, true); }
      dragging.placeholder.remove();
      if (before && before.parentElement === list) list.insertBefore(dragging.placeholder, before); else list.append(dragging.placeholder);
      dragging.targetList = list;
    }
    function cleanupDrag() {
      if (!dragging) return;
      dragging.ghost.remove(); dragging.placeholder.remove(); dragging.item.classList.remove('is-dragged'); container.classList.remove('is-dragging');
      dragging = null;
    }
    async function finishDrag() {
      if (!dragging) return;
      const d = dragging; const placeholder = d.placeholder, targetList = placeholder.parentElement;
      if (!targetList) { cleanupDrag(); return; }
      const targetIndex = siblings(targetList, d.kind).filter(n => n !== d.item).indexOf(placeholder.previousElementSibling && siblings(targetList, d.kind).includes(placeholder.previousElementSibling) ? placeholder.previousElementSibling : null) + 1;
      // Índice destino = número de hermanos (sin el arrastrado) que quedan antes del marcador.
      let position = 0; for (const child of Array.from(targetList.children)) { if (child === placeholder) break; if (child !== d.item && (d.kind === 'video' ? child.classList.contains('tree-class') : child.classList.contains('tree-node'))) position++; }
      const sameList = targetList === d.list;
      const item = d.item, kind = d.kind, list = d.list;
      cleanupDrag();
      void targetIndex;
      if (sameList) { if (position !== d.from) await commitOrder(list, kind, d.from, position); return; }
      if (kind !== 'video') return;
      const moduleId = targetList.dataset.moduleId || null;
      const videoId = item.dataset.videoId;
      const video = lastTree && findVideo(lastTree, videoId);
      if (!video) return;
      await actions.moveClass(video, moduleId, position);
    }
    function findVideo(tree, videoId) {
      for (const v of tree.orphans) if (v.videoId === videoId) return v;
      for (const node of tree.nodes.values()) for (const v of node.videos) if (v.videoId === videoId) return v;
      return null;
    }
    async function commitOrder(list, kind, fromIndex, toIndex) {
      const items = siblings(list, kind);
      const ids = moveWithin(items.map(n => ({ id: kind === 'video' ? n.dataset.videoId : n.dataset.moduleId })), fromIndex, toIndex);
      if (!ids) return;
      const previous = items.map(n => n);
      // Orden optimista con restauración exacta si el servidor lo rechaza.
      const moved = items[fromIndex]; const reference = toIndex > fromIndex ? items[toIndex].nextElementSibling : items[toIndex];
      if (reference) list.insertBefore(moved, reference); else list.append(moved);
      const revert = () => { for (const n of previous) list.append(n); list.querySelectorAll('.tree-empty').forEach(x => list.append(x)); };
      const container_ = kind === 'video' ? (list.dataset.moduleId || null) : (list.dataset.parentId || null);
      await actions.reorder({ kind: kind === 'video' ? 'videos' : 'modules', container: container_, ids, revert });
    }

    function render(tree, { openAll = false } = {}) {
      lastTree = tree;
      if (dragging) return; // nunca se pisa un arrastre en curso con una actualización periódica
      if (openAll || !openState.size) tree.roots.forEach(n => openState.add(n.module.id));
      container.replaceChildren();
      const list = el('ul', 'tree-list tree-root'); list.dataset.listKind = 'module'; list.dataset.parentId = '';
      for (const node of tree.roots) list.append(moduleRow(node, 0));
      container.append(list);
      if (tree.orphans.length) {
        const box = el('section', 'tree-orphans-box');
        box.innerHTML = '<div class="tree-row tree-module orphan"><span class="tree-icon module" aria-hidden="true">▢</span><span class="tree-title">Sin módulo</span><span class="muted tree-count">' + html(tree.orphans.length) + ' clase' + (tree.orphans.length === 1 ? '' : 's') + ' fuera de los módulos · arrástralas o usa «Mover a…»</span></div>';
        const orphanList = el('ul', 'tree-list tree-classes tree-orphans'); orphanList.dataset.moduleId = ''; orphanList.dataset.listKind = 'video';
        for (const v of tree.orphans) orphanList.append(classRow(v, orphanList));
        box.append(orphanList); container.append(box);
      }
    }
    return { render, toggle, isDragging: () => !!dragging, openState: () => new Set(openState), setOpen: ids => { openState = new Set(ids); } };
  }
  return { buildTree, descendantIds, canReparent, countClasses, moveWithin, statusLabel, createTreeView };
});
