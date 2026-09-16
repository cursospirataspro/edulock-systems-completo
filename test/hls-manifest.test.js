'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rewriteBunnyManifest,verifyResourceSignature,belongsToVideo,segmentIV}=require('../lib/hls-manifest');
const options={targetUrl:'https://test.b-cdn.net/video/720p/playlist.m3u8',catalogUrl:'https://test.b-cdn.net/video/playlist.m3u8',videoId:'video',token:'test-token',baseUrl:'http://localhost:3100',keyUri:'http://localhost:3100/api/drm/key/test?ktok=test',secret:'test-only-signing-key'};
test('manifest header remains first and each clear segment gets its own matching IV',()=>{
 const out=rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST'});
 assert.match(out,/^#EXTM3U/);assert.match(out,/IV=0x00000000000000000000000000000009/);assert.match(out,/IV=0x0000000000000000000000000000000a/);
 const urls=out.split('\n').filter(x=>x.startsWith('http://localhost:3100/api/b'));
 assert.equal(urls.length,2);
 for(const url of urls){const q=new URL(url).searchParams;const upstream=Buffer.from(q.get('seg'),'base64url').toString();assert.equal(verifyResourceSignature(options.secret,q.get('sig'),'segment','video',upstream,q.get('enc'),q.get('idx')),true);assert.equal(verifyResourceSignature(options.secret,q.get('sig'),'segment','video',upstream,'0',q.get('idx')),false);}
});
test('master rewrites both alternate audio and variants to authenticated manifests',()=>{
 const out=rewriteBunnyManifest({...options,targetUrl:options.catalogUrl,content:'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/playlist.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/playlist.m3u8'});
 assert.equal((out.match(/\/api\/r\/video\?/g)||[]).length,2);assert.equal(out.includes('EXT-X-KEY'),false);
});
test('upstream AES keeps its IV and receives a signed key proxy',()=>{
 const out=rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x123\n#EXTINF:3,\na.ts'});
 assert.match(out,/IV=0x123/);assert.match(out,/\/api\/drm\/proxy-key\?/);assert.match(out,/enc=0/);assert.equal(out.includes('ktok='),false);
});
test('foreign videos, other hosts and traversal cannot be signed into the playlist',()=>{
 for(const source of ['https://test.b-cdn.net/other/a.ts','https://evil.example/video/a.ts','../../other/a.ts'])assert.throws(()=>rewriteBunnyManifest({...options,content:'#EXTM3U\n'+source}),/ajeno/);
 assert.equal(belongsToVideo('https://test.b-cdn.net/video/720p/a.ts',options.catalogUrl),true);
 assert.equal(belongsToVideo('https://test.b-cdn.net/video-2/a.ts',options.catalogUrl),false);
});
test('provider HTML/error response and unsupported DRM fail explicitly',()=>{
 assert.throws(()=>rewriteBunnyManifest({...options,content:'<html>Error</html>'}),/válida/);
 assert.throws(()=>rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\na.ts'}),/DRM/);
});

test('mixed upstream encryption applies the local key to every clear segment',()=>{
 const out=rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\nclear-first.ts\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x123\nprotected.ts\n#EXT-X-KEY:METHOD=NONE\nclear-last.ts'});
 const segmentUrls=out.split('\n').filter(line=>line.startsWith(options.baseUrl+'/api/b'));
 assert.deepEqual(segmentUrls.map(line=>new URL(line).searchParams.get('enc')),['1','0','1']);
 assert.deepEqual(segmentUrls.map(line=>new URL(line).searchParams.get('idx')),['2','3','4']);
 assert.match(out,/#EXT-X-KEY:METHOD=NONE\n#EXT-X-KEY:METHOD=AES-128,URI="[^\"]+ktok=test",IV=0x00000000000000000000000000000004/);
 assert.throws(()=>rewriteBunnyManifest({...options,keyUri:null,content:'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\na.ts\n#EXT-X-KEY:METHOD=NONE\nb.ts'}),/clave/);
});

test('init maps and later clear media segments use their declared IVs',()=>{
 const out=rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s'});
 assert.match(out,/IV=0x00000000000000000000000000000000\n#EXT-X-MAP:URI="[^\"]+idx=0"/);
 assert.match(out,/IV=0x00000000000000000000000000000007/);
});

test('large media sequences preserve the full 128-bit IV without Number rounding',()=>{
 const sequence='9007199254740993';
 const out=rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:'+sequence+'\na.ts'});
 assert.match(out,/idx=9007199254740993/);assert.ok(out.includes('IV=0x'+segmentIV(sequence).toString('hex')));
 assert.equal(segmentIV('4294967296').toString('hex'),'00000000000000000000000100000000');
 assert.equal(segmentIV('0009').toString('hex'),'00000000000000000000000000000009');
 for(const invalid of ['-1','1e3','1.5','',String(1n<<128n),Number.MAX_SAFE_INTEGER+1])assert.throws(()=>segmentIV(invalid),/Índice/);
});

test('unsupported byte ranges, partial segments and session keys fail explicitly',()=>{
 for(const line of ['#EXT-X-BYTERANGE:100@0','#EXT-X-MAP:BYTERANGE="100@0",URI="init.mp4"','#EXT-X-PART:DURATION=0.3,URI="part.ts"','#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part.ts"','#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"']){
  assert.throws(()=>rewriteBunnyManifest({...options,content:'#EXTM3U\n'+line+'\na.ts'}),/formato HLS/);
 }
 assert.throws(()=>rewriteBunnyManifest({...options,content:'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="unsupported"\na.ts'}),/DRM/);
});
