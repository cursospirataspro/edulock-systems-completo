'use strict';
// Fully synthetic PDF, valid cross-reference offsets, no dependencies or data.
module.exports = function createPdf(pages = 2) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const children = [];
    for (let page = 1; page <= pages; page++) {
        const pageObject = objects.length + 1, streamObject = pageObject + 1;
        const stream = `BT /F1 18 Tf 40 700 Td (Edulock synthetic PDF - Page ${page}) Tj ET`;
        children.push(pageObject + ' 0 R');
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObject} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    }
    objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${children.join(' ')}] >>`;
    let content = '%PDF-1.7\n';
    const offsets = [0];
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(content);
    content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    content += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(content);
};
