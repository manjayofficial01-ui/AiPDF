import assert from 'node:assert/strict';
import {multiply,inverse,imageCorners,inspectImagePlacements,buildImageEdit,buildObjectEdit,tokenizeImageContent} from '../src/renderer/js/image-objects.mjs';
const resources={Im0:{kind:'image',ref:'9 0 R',width:2,height:2},Form0:{kind:'form',ref:'10 0 R'}};
let checks=0;
function test(name,fn){fn();checks++;console.log('PASS '+name);}
function near(a,b){a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-6,`${a} != ${b}`));}
const source='q\n100 0 0 50 20 30 cm\n/Im0 Do\nQ\nq\n80 0 0 40 220 130 cm\n/Im0 Do\nQ\n';
const scan=inspectImagePlacements(source,resources),first=scan.images[0];
test('detect two placements of one image resource',()=>assert.equal(scan.images.length,2));
test('recover first image matrix',()=>near(first.matrix,[100,0,0,50,20,30]));
test('recover first image bounds',()=>near(first.bounds,[20,30,120,80]));
test('distinct occurrence IDs',()=>assert.notEqual(scan.images[0].id,scan.images[1].id));
for(const rotation of [0,90,180,270,37])for(const flipX of [false,true])for(const flipY of [false,true]){
  test(`transform ${rotation}/${flipX}/${flipY} leaves other placement intact`,()=>{
    const edited=buildImageEdit(scan,first.id,{dx:12,dy:-7,scaleX:1.5,scaleY:.5,rotation,flipX,flipY});
    const after=inspectImagePlacements(edited.source,resources);
    assert.equal(after.images.length,2);near(after.images[1].matrix,scan.images[1].matrix);
    const corners=imageCorners(after.images[0].matrix);near([corners.reduce((s,p)=>s+p[0],0)/4,corners.reduce((s,p)=>s+p[1],0)/4],[82,48]);
    assert.equal(edited.source.slice(0,first.start),source.slice(0,first.start));
    assert.ok(edited.source.endsWith(source.slice(first.end)));
  });
}
test('move changes translation only',()=>near(inspectImagePlacements(buildImageEdit(scan,first.id,{dx:10,dy:20}).source,resources).images[0].matrix,[100,0,0,50,30,50]));
test('delete only selected occurrence',()=>{const after=inspectImagePlacements(buildImageEdit(scan,first.id,{delete:true}).source,resources);assert.equal(after.images.length,1);near(after.images[0].matrix,scan.images[1].matrix);});
test('replacement is instance-local',()=>{const after=inspectImagePlacements(buildImageEdit(scan,first.id,{replacementName:'/NewImage'}).source,{...resources,NewImage:{kind:'image',ref:'11 0 R'}});assert.equal(after.images[0].name,'NewImage');assert.equal(after.images[1].name,'Im0');});
test('opacity requires generated graphics state',()=>assert.throws(()=>buildImageEdit(scan,first.id,{opacity:.5})));
test('opacity scoped inside q/Q',()=>assert.match(buildImageEdit(scan,first.id,{opacity:.5,graphicsStateName:'/GS1'}).source,/q\n1 0 0 1 0 0 cm\n\/GS1 gs\n\/Im0 Do\nQ/));
test('crop inserts image-space clip',()=>assert.match(buildImageEdit(scan,first.id,{crop:[.1,.2,.9,.8]}).source,/0.1 0.2 0.8 0.6 re W n/));
test('names support hex escapes',()=>assert.equal(inspectImagePlacements('q 1 0 0 1 0 0 cm /Im#30 Do Q',resources).images[0].name,'Im0'));
test('strings and comments are not operators',()=>assert.equal(inspectImagePlacements('% /Im0 Do\nBT (q /Im0 Do BI Q) Tj ET\n<4249> Tj\n',resources).images.length,0));
test('arrays and dictionaries do not corrupt stack',()=>assert.equal(inspectImagePlacements('/Tag << /ActualText (q Q) /Flag true >> BDC BT [(q) 20 (Q)] TJ ET EMC\n',resources).images.length,0));
test('nested forms explicitly reported',()=>assert.equal(inspectImagePlacements('/Form0 Do',resources).unsupported[0].reason,'nested-form'));
for(const malformed of ['BI /W 1 ID abc EI','Q','q','1 0 cm /Im0 Do','(unterminated','[1 2','/Im#zz Do','/Im0 /Im0 Do'])test('reject unsupported or malformed '+malformed,()=>assert.throws(()=>inspectImagePlacements(malformed,resources)));
for(const change of [{scaleX:0},{scaleY:-1},{dx:NaN},{rotation:Infinity},{opacity:-1,graphicsStateName:'/GS1'},{crop:[0,0,0,1]},{crop:[-1,0,1,1]},{flipX:'yes'},{unknown:1},{delete:true,dx:1},{replacementName:'/bad name'}])test('reject invalid edit '+JSON.stringify(change),()=>assert.throws(()=>buildImageEdit(scan,first.id,change)));
test('refuse existing path clipping',()=>{const s=inspectImagePlacements('q 0 0 200 200 re W n 100 0 0 100 0 0 cm /Im0 Do Q',resources);assert.throws(()=>buildImageEdit(s,s.images[0].id,{dx:10}));});
test('refuse pending path',()=>{const s=inspectImagePlacements('0 0 m /Im0 Do',resources);assert.throws(()=>buildImageEdit(s,s.images[0].id,{dx:10}));});
test('refuse singular matrix',()=>{const s=inspectImagePlacements('0 0 0 0 0 0 cm /Im0 Do',resources);assert.throws(()=>buildImageEdit(s,s.images[0].id,{dx:1}));});
test('matrix inverse roundtrip',()=>near(multiply([100,20,10,50,-30,40],inverse([100,20,10,50,-30,40])),[1,0,0,1,0,0]));

/* ── The object model: containers, inline images, paint order ─────────────
 *  A page that LOOKS flat can still hold separately addressable objects.
 *  These checks are the mechanism: read the content stream, descend into the
 *  Form XObjects it draws, and report each object with page coordinates. */

const formResources={Fm0:{kind:'form',ref:'10 0 R'}};
const formPage='q 200 0 0 150 50 50 cm\n/Fm0 Do\nQ\n';
const resolveForm=(name)=>name==='Fm0'
  ?{source:'/Im0 Do',resources:{Im0:{kind:'image',ref:'9 0 R'}},matrix:[1,0,0,1,0,0],bbox:[0,0,1,1]}
  :null;
const nested=inspectImagePlacements(formPage,formResources,{resolveForm});
test('a form is reported as a container object',()=>{assert.equal(nested.objects.length,2);assert.equal(nested.objects[0].kind,'form');assert.equal(nested.objects[0].name,'Fm0');});
test('the form group is bounded by its BBox',()=>near(nested.objects[0].bounds,[50,50,250,200]));
test('the image inside the form is found',()=>{assert.equal(nested.images.length,1);assert.equal(nested.images[0].kind,'image');assert.deepEqual(nested.images[0].container,['Fm0']);});
test('a nested image is reported in PAGE coordinates',()=>near(nested.images[0].matrix,[200,0,0,150,50,50]));
test('a nested image names the stream that holds it',()=>assert.equal(nested.images[0].streamKey,'form:Fm0'));
test('the form is painted before its children',()=>assert.ok(nested.objects[0].order<nested.objects[1].order));
test('a form that cannot be resolved stays unsupported',()=>{assert.equal(inspectImagePlacements(formPage,formResources).unsupported[0].reason,'nested-form');});
test('a form that draws itself is refused',()=>{
  const s=inspectImagePlacements(formPage,formResources,{resolveForm:(n)=>n==='Fm0'?{source:'/Fm0 Do',resources:formResources,matrix:[1,0,0,1,0,0]}:null});
  assert.ok(s.unsupported.some(u=>u.reason==='recursive-form'));
});
test('a form inside a form is descended into',()=>{
  const s=inspectImagePlacements('/Fm0 Do',{Fm0:{kind:'form',ref:'10 0 R'}},{resolveForm:(n)=>n==='Fm0'
    ?{source:'q 2 0 0 2 0 0 cm /Fm1 Do Q',resources:{Fm1:{kind:'form',ref:'11 0 R'}},matrix:[1,0,0,1,0,0]}
    :{source:'/Im0 Do',resources:{Im0:{kind:'image',ref:'9 0 R'}},matrix:[1,0,0,1,0,0]}});
  assert.equal(s.images.length,1);
  assert.deepEqual(s.images[0].container,['Fm0','Fm1']);
  near(s.images[0].matrix,[2,0,0,2,0,0]);
});

const inlineSource='q 100 0 0 100 20 20 cm\nBI << /W 2 /H 2 /CS /G /BPC 8 >> ID \x01\x02\x03\x04 EI\nQ\n';
const inlineScan=inspectImagePlacements(inlineSource,{});
test('an inline image is an object, not a parse failure',()=>{assert.equal(inlineScan.images.length,1);assert.equal(inlineScan.images[0].kind,'inline');});
test('an inline image keeps its placement',()=>near(inlineScan.images[0].matrix,[100,0,0,100,20,20]));
test('an inline image does not hide the objects around it',()=>{
  const s=inspectImagePlacements('q 10 0 0 10 0 0 cm /Im0 Do Q\n'+inlineSource,resources);
  assert.equal(s.images.length,2);
  assert.equal(s.images[0].kind,'image');
  assert.equal(s.images[1].kind,'inline');
});
test('an inline image can be moved without touching its bytes',()=>{
  const edited=buildImageEdit(inlineScan,inlineScan.images[0].id,{dx:20,dy:10});
  assert.ok(edited.source.includes('BI << /W 2 /H 2 /CS /G /BPC 8 >> ID \x01\x02\x03\x04 EI'));
  // The delta is in the image's own space: 20pt of a 100pt-wide image.
  assert.match(edited.source,/q\n1 0 0 1 0\.2 0\.1 cm\n/);
});
test('an inline image refuses a replacement file',()=>assert.throws(()=>buildImageEdit(inlineScan,inlineScan.images[0].id,{replacementName:'/New'})));
test('an inline image can be deleted',()=>assert.equal(buildImageEdit(inlineScan,inlineScan.images[0].id,{delete:true}).source.includes('BI'),false));
test('later objects are painted over earlier ones',()=>{
  const s=inspectImagePlacements('q 100 0 0 100 0 0 cm /Im0 Do Q\nq 50 0 0 50 10 10 cm /Im0 Do Q',resources);
  assert.equal(s.objects.length,2);
  assert.ok(s.objects[1].order>s.objects[0].order);
});

/* A group is changed in the PAGE stream, so a form other pages share is
 * never modified. */
test('a group is moved through the page stream',()=>{
  const edited=buildObjectEdit(nested,nested.objects[0].id,{dx:20,dy:10});
  assert.ok(edited.source.includes('/Fm0 Do'));
  // 20pt and 10pt of a group that is 200x150 pt on the page.
  assert.match(edited.source,/q\n1 0 0 1 0\.1 0\.0666666667 cm\n\/Fm0 Do\nQ/);
  assert.equal(edited.streamKey,'page');
});
test('a group refuses a crop',()=>assert.throws(()=>buildObjectEdit(nested,nested.objects[0].id,{crop:[0,0,1,1]})));
test('a nested image edit is expressed in its own stream',()=>{
  const edited=buildImageEdit(nested,nested.images[0].id,{dx:20,dy:10});
  assert.equal(edited.streamKey,'form:Fm0');
  assert.match(edited.source,/1 0 0 1 0\.1 0\.0666666667 cm/);
  assert.ok(!edited.source.includes('/Fm0 Do'),'the page stream is not touched by a nested edit');
});
console.log(JSON.stringify({checks,failed:0,scope:'Native object content-stream core, not Electron or PDF-library adapter'}));
