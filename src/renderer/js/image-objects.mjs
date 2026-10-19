/** Native image-placement edits. No PDF-library, DOM, or network dependency. */
const I=[1,0,0,1,0,0];
export function multiply(a,b){
  return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function inverse(m){
  const [a,b,c,d,e,f]=m,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw new Error('Singular image transform');
  return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
}
export function imageCorners(m){return [[0,0],[1,0],[1,1],[0,1]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);}
function finite(n){if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e8)throw new Error('Invalid numeric image argument');return n;}
function number(n){finite(n);return String(Number(n.toFixed(10)));}
function resourceName(n){if(typeof n!=='string'||!/^\/[A-Za-z][A-Za-z0-9_]*$/.test(n))throw new Error('Invalid generated resource name');return n;}
const whitespace=c=>c!==undefined&&/[\x00\x09\x0a\x0c\x0d\x20]/.test(c);
const delimiter=c=>c===undefined||whitespace(c)||'()<>[]{}/%'.includes(c);

/** Byte offsets are preserved; inline image data is refused, never guessed at. */
export function tokenizeImageContent(source){
  if(typeof source!=='string'||source.length>8*1024*1024)throw new Error('Page stream exceeds image editor limit');
  const out=[];let i=0;
  while(i<source.length){
    if(out.length>=200000)throw new Error('Too many page tokens');
    const start=i,c=source[i];
    if(whitespace(c)){i++;continue;}
    if(c==='%'){while(i<source.length&&!['\r','\n'].includes(source[i]))i++;continue;}
    if(c==='('){
      let depth=1;i++;
      while(i<source.length&&depth){if(source[i]==='\\'){i+=2;continue;}if(source[i]==='(')depth++;if(source[i]===')')depth--;i++;}
      if(depth)throw new Error('Unterminated PDF string');
      out.push({type:'value',start,end:i});continue;
    }
    if(c==='<'&&source[i+1]!=='<'){
      const end=source.indexOf('>',i+1);if(end<0)throw new Error('Unterminated PDF hex string');
      if(!/^[0-9a-f\s]*$/i.test(source.slice(i+1,end)))throw new Error('Invalid PDF hex string');
      i=end+1;out.push({type:'value',start,end:i});continue;
    }
    if(source.slice(i,i+2)==='<<'||source.slice(i,i+2)==='>>'){
      const value=source.slice(i,i+2);i+=2;out.push({type:'delimiter',value,start,end:i});continue;
    }
    if('[]'.includes(c)){i++;out.push({type:'delimiter',value:c,start,end:i});continue;}
    if(c==='/'){
      i++;while(i<source.length&&!delimiter(source[i]))i++;
      const raw=source.slice(start,i);
      if(/#(?![0-9a-f]{2})/i.test(raw))throw new Error('Malformed escaped PDF name');
      const value=raw.slice(1).replace(/#([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
      out.push({type:'name',value,raw,start,end:i});continue;
    }
    if(delimiter(c))throw new Error('Unexpected PDF delimiter');
    while(i<source.length&&!delimiter(source[i]))i++;
    const value=source.slice(start,i);
    if(value==='BI')throw new Error('Inline images are not supported in this first version');
    const numeric=/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value);
    out.push({type:numeric?'number':['true','false','null'].includes(value)?'value':'operator',value:numeric?Number(value):value,start,end:i});
  }
  return out;
}

/** resources maps decoded PDF names to {kind:'image'|'form',...metadata}. */
export function inspectImagePlacements(source,resources){
  if(!resources||typeof resources!=='object')throw new Error('Resolved XObject resources are required');
  const tokens=tokenizeImageContent(source),images=[],unsupported=[];
  let state={matrix:I.slice(),clipped:false,textMode:0},operands=[],stack=[],containers=[];
  let ordinal=0,path=false;
  for(const token of tokens){
    if(token.type==='delimiter'){
      const opening=['[','<<'].includes(token.value);
      if(opening){containers.push(token.value);if(containers.length>64)throw new Error('PDF container nesting too deep');}
      else if(containers.pop()!==({']':'[','>>':'<<'}[token.value]))throw new Error('Unbalanced PDF container');
      operands.push(token);continue;
    }
    if(containers.length){continue;}
    if(token.type!=='operator'){operands.push(token);continue;}
    const op=token.value;
    if(op==='q'){
      if(operands.length||stack.length>=256)throw new Error('Invalid graphics-state stack');
      stack.push({...state,matrix:state.matrix.slice()});
    }else if(op==='Q'){
      if(operands.length||!stack.length)throw new Error('Unbalanced graphics state');
      state=stack.pop();
    }else if(op==='cm'){
      if(operands.length!==6||operands.some(t=>t.type!=='number'||!Number.isFinite(t.value)))throw new Error('Malformed cm operator');
      state.matrix=multiply(state.matrix,operands.map(t=>t.value));state.matrix.forEach(finite);
    }else if(op==='W'||op==='W*'){state.clipped=true;}
    else if(op==='Tr'){
      if(operands.length!==1||operands[0].type!=='number'||!Number.isInteger(operands[0].value)||operands[0].value<0||operands[0].value>7)throw new Error('Malformed text rendering mode');
      state.textMode=operands[0].value;
    }else if(['Tj','TJ',"'",'"'].includes(op)&&state.textMode>=4){state.clipped=true;}
    else if(['m','l','c','v','y','re','h'].includes(op)){path=true;}
    else if(['S','s','f','F','f*','B','B*','b','b*','n'].includes(op)){path=false;}
    else if(op==='Do'){
      if(operands.length!==1||operands[0].type!=='name')throw new Error('Malformed XObject invocation');
      const operand=operands[0],resource=Object.hasOwn(resources,operand.value)?resources[operand.value]:null;
      if(resource?.kind==='image'){
        const corners=imageCorners(state.matrix),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
        let singular=false;try{inverse(state.matrix);}catch{singular=true;}
        images.push({id:`image:${operand.start}:${token.end}`,ordinal:ordinal++,name:operand.value,rawName:operand.raw,start:operand.start,end:token.end,matrix:state.matrix.slice(),corners,bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],clipped:state.clipped,pendingPath:path,singular,resource:{...resource}});
      }else{unsupported.push({name:operand.value,reason:resource?.kind==='form'?'nested-form':'unresolved-xobject'});}
    }
    operands=[];
  }
  if(containers.length||stack.length||operands.length)throw new Error('Incomplete or unbalanced page stream');
  return {source,images,unsupported};
}

/** Transforms are applied about the image center in unrotated PDF user space. */
export function changedImageMatrix(matrix,change){
  const dx=finite(change.dx??0),dy=finite(change.dy??0),sx=finite(change.scaleX??1),sy=finite(change.scaleY??1),angle=finite(change.rotation??0)*Math.PI/180;
  if(sx<=0||sy<=0||sx>1000||sy>1000)throw new Error('Image scales must be positive and at most 1000');
  for(const key of ['flipX','flipY'])if(key in change&&typeof change[key]!=='boolean')throw new Error('Flip flags must be boolean');
  const cx=(matrix[0]+matrix[2])/2+matrix[4],cy=(matrix[1]+matrix[3])/2+matrix[5];
  const c=Math.cos(angle),s=Math.sin(angle);
  return multiply(multiply(multiply(multiply([1,0,0,1,cx+dx,cy+dy],[c,s,-s,c,0,0]),[sx*(change.flipX?-1:1),0,0,sy*(change.flipY?-1:1),0,0]),[1,0,0,1,-cx,-cy]),matrix);
}

/** Replace one Do invocation, preserving every byte outside its source span. */
export function buildImageEdit(snapshot,id,change={}){
  const allowed=new Set(['dx','dy','scaleX','scaleY','rotation','flipX','flipY','delete','crop','opacity','replacementName','graphicsStateName']);
  if(!change||typeof change!=='object'||Array.isArray(change)||Object.keys(change).some(k=>!allowed.has(k)))throw new Error('Unknown image-edit option');
  const fresh=inspectImagePlacements(snapshot.source,Object.fromEntries(snapshot.images.map(im=>[im.name,im.resource])));
  const image=fresh.images.find(im=>im.id===id);
  if(!image)throw new Error('Image placement no longer exists');
  if('delete' in change&&typeof change.delete!=='boolean')throw new Error('Delete flag must be boolean');
  let replacement;
  if(change.delete){
    if(Object.keys(change).some(k=>k!=='delete'))throw new Error('Deletion cannot be mixed with other edits');
    replacement='';
  }else{
    if(image.clipped||image.pendingPath||image.singular||image.resource.imageMask)throw new Error('This image placement requires an unsupported clipping, path, mask, or transform operation');
    const desired=changedImageMatrix(image.matrix,change),local=multiply(inverse(image.matrix),desired);
    const commands=['q',local.map(number).join(' ')+' cm'];
    if('crop' in change){
      const r=change.crop;
      if(!Array.isArray(r)||r.length!==4||r.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)||r[2]<=r[0]||r[3]<=r[1])throw new Error('Image crop must be a nonempty normalized rectangle');
      commands.push([r[0],r[1],r[2]-r[0],r[3]-r[1]].map(number).join(' ')+' re W n');
    }
    if('opacity' in change){
      if(typeof change.opacity!=='number'||!Number.isFinite(change.opacity)||change.opacity<0||change.opacity>1)throw new Error('Opacity must be in [0,1]');
      commands.push(resourceName(change.graphicsStateName)+' gs');
    }else if('graphicsStateName' in change)throw new Error('Unexpected graphics state name');
    commands.push((change.replacementName?resourceName(change.replacementName):image.rawName)+' Do','Q');
    replacement=commands.join('\n');
  }
  return {source:snapshot.source.slice(0,image.start)+replacement+snapshot.source.slice(image.end),imageId:id,removed:!!change.delete};
}
