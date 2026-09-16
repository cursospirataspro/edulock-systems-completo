const http = require('http');
const url = 'http://127.0.0.1:3000/api/watermark/stream/__default__?os=windows&token=testtoken';
console.log('Connecting to', url);
const req = http.request(url, {method:'GET', headers: {Accept: 'text/event-stream'}}, res => {
  console.log('Response status', res.statusCode, 'content-type', res.headers['content-type']);
  res.setEncoding('utf8');
  res.on('data', chunk => {
    process.stdout.write(chunk);
  });
  res.on('end', () => {
    console.log('\nSSE connection ended');
  });
});
req.on('error', err => console.error('SSE error', err.message));
req.end();
setTimeout(() => {
  const data = JSON.stringify({ courseId: '__default__', os: 'windows', config: { visible: { size: 50, color: '#ff0000', alpha: 0.45 }, forensic: { size: 10, color: '#00ff00', alpha: 0.12 } } });
  const opts = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/watermark/config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };
  const req2 = http.request(opts, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => body += chunk);
    res.on('end', () => console.log('POST response', res.statusCode, body));
  });
  req2.on('error', err => console.error('POST error', err.message));
  req2.write(data);
  req2.end();
}, 3000);
setTimeout(() => process.exit(0), 12000);
