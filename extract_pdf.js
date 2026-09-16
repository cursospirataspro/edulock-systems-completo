const fs = require('fs');
const PDFParser = require('pdf2json');
const pdfParser = new PDFParser();
pdfParser.on('pdfParser_dataError', err => { console.error('ERR', err.parserError); process.exit(1); });
pdfParser.on('pdfParser_dataReady', pdfData => {
  const pages = pdfData.formImage?.Pages || [];
  console.log('pages', pages.length);
  pages.slice(0,2).forEach((page, idx) => {
    const text = page.Texts.map(t => t.R.map(r => decodeURIComponent(r.T)).join('')).join(' ');
    console.log('---PAGE', idx+1, '---');
    console.log(text.slice(0,2000));
  });
});
pdfParser.loadPDF('IMPLEMENTACION_VPS_marca_agua_tiempo_real.pdf');
