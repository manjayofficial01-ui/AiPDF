import assert from 'node:assert/strict';
import {multiply,inverse,imageCorners,inspectImagePlacements,buildImageEdit,tokenizeImageContent} from '../src/renderer/js/image-objects.mjs';
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
console.log(JSON.stringify({checks,failed:0,scope:'Native image content-stream core, not Electron or PDF-library adapter'}));
