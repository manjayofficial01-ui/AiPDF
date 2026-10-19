import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createImagePdfAdapter} from '../src/renderer/js/image-pdf.mjs';
const require=createRequire(import.meta.url);
const entry=process.env.AIPDF_PDF_LIB_ENTRY||require.resolve('@cantoo/pdf-lib');
let PL;
if(process.env.AIPDF_TEST_BROWSER_BUNDLE==='1'){
  let root=path.dirname(entry);
  while(root!==path.dirname(root)){
    const pkg=path.join(root,'package.json');
    if(fs.existsSync(pkg)&&JSON.parse(fs.readFileSync(pkg,'utf8')).name==='@cantoo/pdf-lib')break;
    root=path.dirname(root);
  }
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aipdf-pdf-bundle-'));
  const copy=path.join(temp,'pdf-lib.mjs');fs.copyFileSync(path.join(root,'dist','pdf-lib.esm.min.js'),copy);
  process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));PL=await import(pathToFileURL(copy));
}else PL=require(entry);
const adapter=createImagePdfAdapter(PL);
const red=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==','base64'));
const blue=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAALHwEDmIWXfgAAAABJRU5ErkJggg==','base64'));
const source='q\n100 0 0 50 20 30 cm\n/Im0 Do\nQ\nq\n80 0 0 40 220 130 cm\n/Im0 Do\nQ\n';
const encode=s=>Uint8Array.from(s,c=>c.charCodeAt(0));
async function fixture({split=false,inherited=false,signature=false}={}){
  const doc=await PL.PDFDocument.create(),image=await doc.embedPng(red);await image.embed();
  doc.setTitle('Image adapter fixture');
  const resources=doc.context.obj({XObject:{Im0:image.ref}});
  const shared=doc.context.register(doc.context.flateStream(encode(source)));
  for(let i=0;i<2;i++){
    const page=doc.addPage([400,300]);
    page.node.set(PL.PDFName.of('Resources'),resources);page.node.set(PL.PDFName.of('Contents'),shared);
  }
  if(split){
    const at=source.indexOf('/Im0 Do');
    doc.getPage(0).node.set(PL.PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream(encode(source.slice(0,at)))),doc.context.register(doc.context.flateStream(encode(source.slice(at))))]));
  }
  if(inherited){
    const parent=doc.context.lookup(doc.getPage(0).node.get(PL.PDFName.of('Parent')));parent.set(PL.PDFName.of('Resources'),resources);
    doc.getPages().forEach(page=>page.node.delete(PL.PDFName.of('Resources')));
  }
  if(signature)doc.context.register(doc.context.obj({Type:'Sig',ByteRange:[0,0,0,0]}));
  return doc.save({useObjectStreams:false});
}
let checks=0;
async function test(name,fn){await fn();checks++;console.log('PASS '+name);}
const original=await fixture(),session=await adapter.open(original,0),other=await adapter.open(original,1);
await test('detect shared image placements',async()=>{assert.equal(session.images.length,2);assert.equal(session.images[0].resource.ref,session.images[1].resource.ref);assert.ok(Object.isFrozen(session.images[0].matrix));});
const cases=[['move',{dx:25,dy:10}],['resize',{scaleX:1.5,scaleY:.5}],['rotate',{rotation:90}],['flip',{flipX:true}],['crop',{crop:[.1,.2,.9,.8]}],['opacity',{opacity:.4}],['delete',{delete:true}],['replace',{replacementBytes:blue,replacementType:'png'}]];
for(const [label,change] of cases)await test('save/reopen '+label,async()=>{
  const saved=await adapter.edit(session,session.images[0].id,change);
  const changed=await adapter.open(saved,0),untouched=await adapter.open(saved,1);
  assert.equal(changed.images.length,label==='delete'?1:2);
  assert.deepEqual(changed.images.at(-1).matrix,[80,0,0,40,220,130]);
  assert.deepEqual(untouched.images,other.images);
  const reopened=await PL.PDFDocument.load(saved,{updateMetadata:false,preserveXFA:true});assert.equal(reopened.getTitle(),'Image adapter fixture');
  const p1=reopened.getPage(0).node,p2=reopened.getPage(1).node;
  assert.notEqual(String(p1.get(PL.PDFName.of('Contents'))),String(p2.get(PL.PDFName.of('Contents'))));
  if(label==='move')assert.deepEqual(changed.images[0].matrix,[100,0,0,50,45,40]);
  if(label==='replace'){
    assert.notEqual(changed.images[0].resource.ref,changed.images[1].resource.ref);
    const refs=p1.Resources().lookup(PL.PDFName.of('XObject'),PL.PDFDict);
    const fresh=reopened.context.lookup(refs.get(PL.PDFName.of(changed.images[0].name)));
    const old=reopened.context.lookup(refs.get(PL.PDFName.of('Im0')));
    assert.notDeepEqual(Array.from(PL.decodePDFRawStream(fresh).decode()),Array.from(PL.decodePDFRawStream(old).decode()));
  }
  if(label==='opacity'){
    const states=p1.Resources().lookup(PL.PDFName.of('ExtGState'),PL.PDFDict);
    assert.equal(reopened.context.lookup(states.get(states.keys()[0])).lookup(PL.PDFName.of('ca'),PL.PDFNumber).asNumber(),.4);
  }
});
for(const options of [{split:true},{inherited:true}])await test('resource/stream layout '+JSON.stringify(options),async()=>{
  const bytes=await fixture(options),s=await adapter.open(bytes,0),saved=await adapter.edit(s,s.images[0].id,{dx:4});
  assert.equal((await adapter.open(saved,1)).images.length,2);assert.deepEqual((await adapter.open(saved,0)).images[0].matrix,[100,0,0,50,24,30]);
});
await test('reject forged session',()=>assert.rejects(()=>adapter.edit({...session},session.images[0].id,{dx:1})));
await test('reject invalid opacity',()=>assert.rejects(()=>adapter.edit(session,session.images[0].id,{opacity:2})));
await test('reject caller resource injection',()=>assert.rejects(()=>adapter.edit(session,session.images[0].id,{replacementName:'/Im0'})));
await test('reject signature-bearing input',async()=>{const signed=await fixture({signature:true});await assert.rejects(()=>adapter.open(signed,0));});
await test('copy input bytes before asynchronous load',async()=>{
  const input=Uint8Array.from(original),pending=adapter.open(input,0);input.fill(0);assert.equal((await pending).images.length,2);
});
await test('close invalidates session',async()=>{const s=await adapter.open(original,0);assert.equal(adapter.close(s),true);await assert.rejects(()=>adapter.edit(s,s.images[0].id,{dx:1}));});
console.log(JSON.stringify({checks,failed:0,build:process.env.AIPDF_TEST_BROWSER_BUNDLE==='1'?'browser-esm':'node-commonjs',scope:'PDF-library save/reopen; no Electron UI or visual rendering'}));
