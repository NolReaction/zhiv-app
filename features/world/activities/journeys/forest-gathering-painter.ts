import { drawGroundedHero } from "@/features/world/scene/grounding";
import { mossPalette } from "@/features/mochlik/appearance-palette";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestGatheringFrame } from "./forest-gathering";

/** Includes the leaning body, outstretched paws and held prop. A parked basket
 * gets its own depth/occlusion entry at the exact ground contact. */
export const forestGatheringBounds=(frame:ForestGatheringFrame)=>({x:frame.x-frame.size*.60,
  y:frame.y-frame.size*1.02,width:frame.size*1.20,height:frame.size*1.06});

/** Basket.y is its exact sole/contact point, shared with depth and navigation. */
export function drawForestGatheringBasket(ctx:CanvasRenderingContext2D, frame:ForestGatheringFrame) {
  const {x,y,size}=frame.basket;
  if(![x,y,size].every(Number.isFinite)||size<=0)return;
  ctx.save();ctx.translate(x,y);ctx.scale(size/20,size/20);
  if(!frame.held) {
    ctx.fillStyle="rgba(25,37,23,.19)";ctx.beginPath();ctx.ellipse(0,-1,9,2.7,0,0,Math.PI*2);ctx.fill();
  }
  ctx.strokeStyle="#65452c";ctx.lineWidth=2;
  ctx.beginPath();ctx.ellipse(0,-10,6,7,0,Math.PI,Math.PI*2);ctx.stroke();
  ctx.fillStyle="#65452c";ctx.beginPath();ctx.moveTo(-10,-11);ctx.lineTo(-8,-1);ctx.lineTo(8,-1);ctx.lineTo(10,-11);ctx.closePath();ctx.fill();
  ctx.fillStyle="#bb8950";ctx.beginPath();ctx.moveTo(-8,-10);ctx.lineTo(-6,0);ctx.lineTo(6,0);ctx.lineTo(8,-10);ctx.closePath();ctx.fill();
  ctx.fillStyle="#e0b879";ctx.fillRect(-9,-11,18,2);
  ctx.strokeStyle="#8f6036";ctx.lineWidth=.8;
  for(const row of [-8,-5,-2]) {ctx.beginPath();ctx.moveTo(-7,row);ctx.lineTo(7,row);ctx.stroke();}
  for(const col of [-5,-1,3]) {ctx.beginPath();ctx.moveTo(col,-9);ctx.lineTo(col+1,-1);ctx.stroke();}
  if(frame.filled) {
    ctx.fillStyle="#65734c";ctx.fillRect(-5,-13,6,3);ctx.fillStyle="#bdac79";ctx.fillRect(-2,-15,2,5);
    ctx.strokeStyle="#69513b";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(2,-11);ctx.lineTo(7,-17);ctx.moveTo(5,-14);ctx.lineTo(8,-14);ctx.stroke();
    ctx.fillStyle="#a7ada0";ctx.fillRect(-6,-12,4,2);
  }
  ctx.restore();
}

/** Continuous shoulders→hands connect searching, lifting, packing and carrying;
 * the cached body supplies only the body and clothes, never duplicate arms. */
export function drawForestGatheringHero(ctx:CanvasRenderingContext2D, frame:ForestGatheringFrame,
  appearance?:{palette:string;head:string|null;neck:string|null},still=false,shadow=true) {
  const {x,y,size}=frame;
  if(![x,y,size].every(Number.isFinite)||size<=0)return;
  const palette=mossPalette(appearance?.palette), side=frame.direction==="left"?-1:1;
  const point=(px:number,py:number):WorldPoint=>({x:x+px*size,y:y+py*size});
  const main=frame.held ? {x:frame.basket.x,y:frame.basket.y-frame.basket.size*.82} : point(frame.hand.x,frame.hand.y);
  const other=frame.held ? {x:frame.basket.x-frame.basket.size*.20,y:main.y+size*.015}
    : point(-side*.20,-.23+frame.crouch/100);
  const rear=frame.direction==="back";
  const arm=(sign:number,hand:WorldPoint)=>{
    const shoulder=point(sign*.18+frame.lean/48,-.33+frame.crouch/85);
    const elbow={x:(shoulder.x+hand.x)/2+sign*size*.04,y:(shoulder.y+hand.y)/2+size*.035};
    ctx.lineCap="round";ctx.lineJoin="round";
    for(const [width,color] of [[size*.064,rear?palette.mossDark:"#d8bf83"],[size*.039,rear?palette.moss:"#f4e4ae"]] as const) {
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(shoulder.x,shoulder.y);ctx.lineTo(elbow.x,elbow.y);ctx.lineTo(hand.x,hand.y);ctx.stroke();
    }
  };
  const prop=()=>{
    if(!frame.itemVisible)return;
    ctx.save();ctx.translate(main.x,main.y);
    if(frame.item==="twig") {ctx.strokeStyle="#7d5934";ctx.lineWidth=size*.036;ctx.beginPath();ctx.moveTo(-size*.04,size*.035);ctx.lineTo(size*.07,-size*.07);ctx.moveTo(size*.02,-size*.02);ctx.lineTo(size*.065,-size*.015);ctx.stroke();}
    else if(frame.item==="stone") {ctx.fillStyle="#c1c3a7";ctx.beginPath();ctx.ellipse(0,-size*.02,size*.055,size*.036,-.3,0,Math.PI*2);ctx.fill();}
    else {ctx.strokeStyle="#a9b376";ctx.lineWidth=size*.023;for(const dx of [-.03,0,.03]) {ctx.beginPath();ctx.moveTo(0,size*.02);ctx.lineTo(size*dx,-size*.07);ctx.stroke();}}
    ctx.restore();
  };
  ctx.save();
  if(rear) {arm(-1,other);arm(1,main);if(frame.held)drawForestGatheringBasket(ctx,frame);prop();}
  drawGroundedHero(ctx,{x,y,size,pose:frame.pose,direction:frame.direction,frame:still?0:frame.frame,appearance,shadow,
    rig:{gardening:true,crouch:frame.crouch,lean:frame.lean}});
  if(!rear) {arm(-side,other);arm(side,main);if(frame.held)drawForestGatheringBasket(ctx,frame);prop();}
  // The near paw crosses the actual handle or finding after it is painted.
  ctx.fillStyle=rear?palette.moss:"#f4e4ae";
  ctx.beginPath();ctx.ellipse(main.x,main.y,size*.023,size*.025,0,0,Math.PI*2);ctx.fill();
  ctx.restore();
}
