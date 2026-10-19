import {inspectImagePlacements,buildImageEdit} from './image-objects.mjs';
const PAGE_LIMIT=8*1024*1024,FILE_LIMIT=32*1024*1024;
function copyBytes(value,limit=FILE_LIMIT){
  const data=value instanceof ArrayBuffer?new Uint8Array(value):value;
  if(!(data instanceof Uint8Array)||!data.length||data.length>limit)throw new Error('Expected bounded nonempty PDF/image bytes');
  return Uint8Array.from(data);
}
function latin1(data){let result='';for(let i=0;i<data.length;i+=32768)result+=String.fromCharCode(...data.subarray(i,i+32768));return result;}
const encode=value=>Uint8Array.from(value,c=>c.charCodeAt(0));
function lookup(PL,doc,dict,key){const value=dict.get(PL.PDFName.of(key));return value?doc.context.lookup(value):undefined;}
function copyDict(PL,doc,value){
  if(value&&!(value instanceof PL.PDFDict))throw new Error('Invalid resource dictionary');
  const result=doc.context.obj({});if(value)for(const key of value.keys())result.set(key,value.get(key));return result;
}
function resourcesFor(PL,doc,page){
  let node=page.node;const seen=new Set();
  while(node){
    if(!(node instanceof PL.PDFDict)||seen.has(node)||seen.size>=64)throw new Error('Invalid page inheritance');seen.add(node);
    const resources=lookup(PL,doc,node,'Resources');if(resources)return resources;
    node=lookup(PL,doc,node,'Parent');
  }
  return doc.context.obj({});
}
function assertEditable(PL,doc){
  if(doc.isEncrypted||doc.context.trailerInfo.Encrypt)throw new Error('Encrypted image editing is not enabled');
  if(doc.catalog.get(PL.PDFName.of('Perms')))throw new Error('Certification permissions require a separate signing workflow');
  for(const [,object] of doc.context.enumerateIndirectObjects()){
    const dict=object instanceof PL.PDFDict?object:object?.dict;
    if(dict&&(dict.has(PL.PDFName.of('ByteRange'))||dict.get(PL.PDFName.of('Type'))?.toString()==='/Sig'||dict.get(PL.PDFName.of('FT'))?.toString()==='/Sig'))throw new Error('Signature-bearing PDFs are read-only in this adapter');
  }
}
function uniqueName(PL,dict,prefix){let n=0;while(dict.has(PL.PDFName.of(prefix+n)))n++;return prefix+n;}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

async function inspect(PL,doc,index){
  if(!Number.isSafeInteger(index)||index<0||index>=doc.getPageCount())throw new Error('Invalid page index');
  const page=doc.getPage(index),contents=lookup(PL,doc,page.node,'Contents');
  const streams=contents instanceof PL.PDFArray?Array.from({length:contents.size()},(_,i)=>doc.context.lookup(contents.get(i))):contents?[contents]:[];
  if(streams.length>4096)throw new Error('Too many content streams');
  const chunks=[];let total=0;
  for(const stream of streams){
    let decoded;
    if(typeof stream?.getUnencodedContents==='function'){
      const raw=stream.getUnencodedContents();if(raw.length>PAGE_LIMIT)throw new Error('Page stream exceeds limit');decoded=latin1(raw);
    }else{
      if(!(stream instanceof PL.PDFRawStream))throw new Error('Unsupported page content stream');
      if(stream.contents.length>PAGE_LIMIT)throw new Error('Encoded page stream exceeds limit');
      const decoder=PL.decodePDFRawStream(stream),parts=[];let size=0;
      if(typeof decoder.getBytes!=='function')throw new Error('PDF decoder does not support bounded reads');
      for(;;){
        const chunk=decoder.getBytes(Math.min(65536,PAGE_LIMIT-size+1));if(!chunk.length)break;
        size+=chunk.length;if(size>PAGE_LIMIT)throw new Error('Decoded stream exceeds limit');parts.push(latin1(chunk));
      }
      decoded=parts.join('');
    }
    total+=decoded.length+1;if(total>PAGE_LIMIT)throw new Error('Decoded page exceeds image editor limit');chunks.push(decoded);
  }
  for(let i=1;i<chunks.length;i++)if(chunks[i-1]&&chunks[i]&&!/[\x00\x09\x0a\x0c\x0d\x20]$/.test(chunks[i-1])&&!/^[\x00\x09\x0a\x0c\x0d\x20]/.test(chunks[i]))throw new Error('Unsupported token boundary between content streams');
  const resources=resourcesFor(PL,doc,page);
  if(!(resources instanceof PL.PDFDict))throw new Error('Invalid page resources');
  const xobjects=lookup(PL,doc,resources,'XObject'),resolved=Object.create(null);
  if(xobjects){
    if(!(xobjects instanceof PL.PDFDict))throw new Error('Invalid XObject dictionary');
    for(const key of xobjects.keys()){
      const ref=xobjects.get(key),object=doc.context.lookup(ref),dict=object?.dict,subtype=dict&&lookup(PL,doc,dict,'Subtype')?.toString();
      if(subtype==='/Image'){
        const width=lookup(PL,doc,dict,'Width'),height=lookup(PL,doc,dict,'Height');
        if(!(width instanceof PL.PDFNumber)||!(height instanceof PL.PDFNumber)||width.asNumber()<=0||height.asNumber()<=0)throw new Error('Invalid image dimensions');
        resolved[key.decodeText()]={kind:'image',ref:String(ref),width:width.asNumber(),height:height.asNumber(),imageMask:lookup(PL,doc,dict,'ImageMask')?.toString()==='true'};
      }else if(subtype==='/Form')resolved[key.decodeText()]={kind:'form',ref:String(ref)};
    }
  }
  return {...inspectImagePlacements(chunks.join('\n'),resolved),pageIndex:index};
}

/** Owns copied input bytes. Edits return new PDF bytes; never writes the live app model. */
export function createImagePdfAdapter(PL){
  for(const name of ['PDFDocument','PDFName','PDFDict','PDFArray','PDFNumber','PDFRawStream','decodePDFRawStream'])if(!PL?.[name])throw new Error('PDF library lacks '+name);
  const sessions=new WeakMap();
  async function load(bytes){const doc=await PL.PDFDocument.load(bytes,{updateMetadata:false,preserveXFA:true});assertEditable(PL,doc);return doc;}
  async function open(input,index=0){
    const bytes=copyBytes(input),doc=await load(bytes),snapshot=await inspect(PL,doc,index);
    const session=freeze({pageIndex:index,pageCount:doc.getPageCount(),images:snapshot.images,unsupported:snapshot.unsupported});
    sessions.set(session,{bytes,snapshot});return session;
  }
  async function edit(session,id,change){
    const stored=sessions.get(session);if(!stored)throw new Error('Unknown or closed image session');
    if(!change||typeof change!=='object'||Array.isArray(change))throw new Error('Image edit must be an object');
    const {replacementBytes,replacementType,...options}=change;
    if(Array.isArray(options.crop))options.crop=options.crop.slice();
    if('graphicsStateName' in options||'replacementName' in options)throw new Error('Resource names are internal');
    if(replacementBytes===undefined&&replacementType!==undefined)throw new Error('Replacement type requires image bytes');
    const replacement=replacementBytes===undefined?null:copyBytes(replacementBytes,PAGE_LIMIT);
    if(replacement&&!['png','jpeg'].includes(replacementType))throw new Error('Replacement must be PNG or JPEG');
    if(options.delete&&replacement)throw new Error('Cannot delete and replace together');
    const doc=await load(Uint8Array.from(stored.bytes)),before=await inspect(PL,doc,session.pageIndex);
    if(before.source!==stored.snapshot.source)throw new Error('Source changed; reopen image session');
    const page=doc.getPage(session.pageIndex),resources=copyDict(PL,doc,resourcesFor(PL,doc,page));
    let graphics,images;
    if('opacity' in options){graphics=copyDict(PL,doc,lookup(PL,doc,resources,'ExtGState'));options.graphicsStateName='/'+uniqueName(PL,graphics,'AiImageGS');}
    buildImageEdit(before,id,{...options,...(replacement?{replacementName:'/AiImagePreview'}:{})});
    if(replacement){
      images=copyDict(PL,doc,lookup(PL,doc,resources,'XObject'));
      const embedded=replacementType==='png'?await doc.embedPng(replacement):await doc.embedJpg(replacement);await embedded.embed();
      const name=uniqueName(PL,images,'AiImage');images.set(PL.PDFName.of(name),embedded.ref);options.replacementName='/'+name;
      resources.set(PL.PDFName.of('XObject'),images);
    }
    if(graphics){graphics.set(PL.PDFName.of(options.graphicsStateName.slice(1)),doc.context.register(doc.context.obj({Type:'ExtGState',ca:options.opacity})));resources.set(PL.PDFName.of('ExtGState'),graphics);}
    const result=buildImageEdit(before,id,options);
    page.node.set(PL.PDFName.of('Resources'),resources);
    page.node.set(PL.PDFName.of('Contents'),doc.context.register(doc.context.flateStream(encode(result.source))));
    const bytes=await doc.save({updateFieldAppearances:false,useObjectStreams:false});
    if(bytes.length>FILE_LIMIT)throw new Error('Edited PDF exceeds adapter file limit');
    const verified=await load(bytes),after=await inspect(PL,verified,session.pageIndex);
    if(verified.getPageCount()!==session.pageCount||after.source!==result.source||after.images.length!==before.images.length-(options.delete?1:0))throw new Error('Saved image edit failed structural verification');
    return bytes;
  }
  return Object.freeze({open,edit,close:session=>sessions.delete(session)});
}
