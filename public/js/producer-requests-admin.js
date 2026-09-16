'use strict';
function requestCell(text) { const td=document.createElement('td');td.textContent=text;return td; }
async function loadProducerRequests() {
    const body=document.getElementById('producer-requests-body'),status=document.getElementById('producer-requests-status');
    if(!body)return;
    status.textContent='Cargando solicitudes…';
    try {
        const data=await api('GET','/api/owner/service-requests');
        body.replaceChildren();
        const labels={licenses:'Licencias adicionales',storage:'Almacenamiento (GB)',support:'Soporte'};
        const states={pending:'Pendiente',approved:'Aprobada',rejected:'Rechazada'};
        for(const item of data.requests) {
            const tr=document.createElement('tr');
            tr.append(requestCell(item.producerName||item.producerEmail||'Productor'),requestCell((labels[item.kind]||item.kind)+(item.quantity?' · '+item.quantity:'')+'\n'+item.message),requestCell(states[item.status]||item.status));
            const replyCell=document.createElement('td'),actions=document.createElement('td');
            if(item.status==='pending') {
                const reply=document.createElement('textarea');reply.maxLength=2000;reply.rows=2;reply.value=item.adminReply||'';reply.setAttribute('aria-label','Respuesta al productor');replyCell.append(reply);
                for(const action of ['approved','rejected']) {
                    const button=document.createElement('button');button.className='btn btn-ghost';button.textContent=action==='approved'?'Aprobar':'Rechazar';
                    if(action==='approved'&&item.kind==='storage'){button.disabled=true;button.title='Requiere capacidad de almacenamiento contratada.';}
                    button.addEventListener('click',async()=>{
                        if(!confirm((action==='approved'?'Aprobar':'Rechazar')+' esta solicitud'+(action==='approved'&&item.kind==='licenses'?' y añadir '+item.quantity+' licencias a su cuota':'')+'?'))return;
                        button.disabled=true;
                        try{await api('PATCH','/api/owner/service-requests/'+encodeURIComponent(item.id),{status:action,adminReply:reply.value});await loadProducerRequests();if(typeof loadProducers==='function')loadProducers();}
                        catch(e){status.textContent=e.message;button.disabled=false;}
                    });actions.append(button);
                }
            } else replyCell.textContent=item.adminReply||'—';
            tr.append(replyCell,actions);body.append(tr);
        }
        if(!data.requests.length){const tr=document.createElement('tr'),td=requestCell('No hay solicitudes.');td.colSpan=5;tr.append(td);body.append(tr);}
        status.textContent='';
    } catch(e){status.textContent=e.message||'No se pudieron cargar las solicitudes.';}
}
