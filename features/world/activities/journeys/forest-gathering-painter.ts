import { drawGroundedHero } from "@/features/world/scene/grounding";
import { mossPalette } from "@/features/mochlik/appearance-palette";
import { drawForestGardenBasket } from "@/features/world/activities/garden/forest-garden-painter";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestGatheringFrame } from "./forest-gathering";
import { forestGatheringArms, type GatheringArm } from "./forest-gathering-rig";

/** Includes the leaning body, outstretched paws and held prop. A parked basket
 * gets its own depth/occlusion entry at the exact ground contact. */
export const forestGatheringBounds=(frame:ForestGatheringFrame)=>({x:frame.x-frame.size*(frame.tool==="shovel"?.78:.60),
  y:frame.y-frame.size*1.02,width:frame.size*(frame.tool==="shovel"?1.56:1.20),height:frame.size*1.12});

/** Basket.y is its exact sole/contact point, shared with depth and navigation. */
export function drawForestGatheringBasket(ctx:CanvasRenderingContext2D, frame:ForestGatheringFrame) {
  if(frame.tool==="shovel")return;
  const {x,y,size}=frame.basket;
  if(![x,y,size].every(Number.isFinite)||size<=0)return;
  drawForestGardenBasket(ctx,{...frame.basket,berries:frame.basket.berries??0,grounded:!frame.held,behind:frame.direction==="back"});
  if(!frame.filled)return;
  // Keep the same woven body and handle as the garden prop. Only its carried
  // findings differ, and they are cosmetic until the account claim succeeds.
  ctx.save();ctx.translate(x,y);ctx.scale(size/14,size/14);
  ctx.fillStyle="#65734c";ctx.fillRect(-4,-9,5,2);ctx.fillStyle="#bdac79";ctx.fillRect(-1,-11,1,4);
  ctx.strokeStyle="#69513b";ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(2,-8);ctx.lineTo(5,-13);ctx.moveTo(4,-11);ctx.lineTo(6,-11);ctx.stroke();
  ctx.fillStyle="#a7ada0";ctx.fillRect(-5,-9,3,2);ctx.restore();
}

function gatheringArm(ctx:CanvasRenderingContext2D,frame:ForestGatheringFrame,sign:number,hand:WorldPoint,palette:ReturnType<typeof mossPalette>) {
  const {x,y,size}=frame,rear=frame.direction==="back";
  const shoulder={x:x+(sign*.18+frame.lean/48)*size,y:y+(-.33+frame.crouch/85)*size};
  const elbow={x:(shoulder.x+hand.x)/2+sign*size*.04,y:(shoulder.y+hand.y)/2+size*.035};
  ctx.lineCap="round";ctx.lineJoin="round";
  for(const [width,color] of [[size*.064,rear?palette.mossDark:"#d8bf83"],[size*.039,rear?palette.moss:"#f4e4ae"]] as const) {
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(shoulder.x,shoulder.y);ctx.lineTo(elbow.x,elbow.y);ctx.lineTo(hand.x,hand.y);ctx.stroke();
  }
}

function basketArm(ctx:CanvasRenderingContext2D,frame:ForestGatheringFrame,arm:GatheringArm,palette:ReturnType<typeof mossPalette>) {
  const rear=frame.direction==="back";
  ctx.lineCap="round";ctx.lineJoin="round";
  for(const [width,color] of [[.071,rear?palette.mossDark:"#b39a66"],[.045,rear?palette.moss:"#f4e4ae"]] as const) {
    ctx.strokeStyle=color;ctx.lineWidth=frame.size*width;ctx.beginPath();ctx.moveTo(arm.shoulder.x,arm.shoulder.y);
    ctx.lineTo(arm.elbow.x,arm.elbow.y);ctx.lineTo(arm.hand.x,arm.hand.y);ctx.stroke();
  }
}

function drawCoastalGatheringHero(ctx:CanvasRenderingContext2D,frame:ForestGatheringFrame,
  appearance:{palette:string;head:string|null;neck:string|null}|undefined,still:boolean,shadow:boolean) {
  const {x,y,size}=frame,side=frame.direction==="left"?-1:1,rear=frame.direction==="back",palette=mossPalette(appearance?.palette);
  const carrying=frame.action==="walk"||frame.action==="ready";
  const tool=carrying||!frame.shovel ? {handle:{x:side*.27,y:-.43},blade:{x:side*.41,y:-.04},soil:0} : frame.shovel;
  const handle={x:x+size*tool.handle.x,y:y+size*tool.handle.y},blade={x:x+size*tool.blade.x,y:y+size*tool.blade.y};
  const dx=blade.x-handle.x,dy=blade.y-handle.y,length=Math.max(.001,Math.hypot(dx,dy)),ux=dx/length,uy=dy/length;
  const point=(along:number,across=0)=>({x:blade.x+size*(ux*along-uy*across),y:blade.y+size*(uy*along+ux*across)});
  const main={x:handle.x+dx*.04,y:handle.y+dy*.04},other={x:handle.x+dx*.48,y:handle.y+dy*.48};
  const paintTool=()=>{
    const neck=point(-.10),edge=[point(0),point(-.04,.06),point(-.13,.055),point(-.15,0),point(-.13,-.055),point(-.04,-.06)];
    ctx.lineCap="round";ctx.lineWidth=size*.045;ctx.strokeStyle="#513b29";
    ctx.beginPath();ctx.moveTo(handle.x,handle.y);ctx.lineTo(neck.x,neck.y);ctx.stroke();
    ctx.lineWidth=size*.024;ctx.strokeStyle="#bc915a";ctx.stroke();
    ctx.fillStyle="#536e68";ctx.strokeStyle="#344b48";ctx.lineWidth=size*.018;
    ctx.beginPath();ctx.moveTo(edge[0].x,edge[0].y);for(const p of edge.slice(1))ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.strokeStyle="#bbccc0";ctx.lineWidth=size*.014;ctx.beginPath();const seam=point(-.12);ctx.moveTo(seam.x,seam.y);ctx.lineTo(blade.x,blade.y);ctx.stroke();
    // A compact D grip, aligned with the shaft, remains visibly in the paw.
    ctx.strokeStyle="#735335";ctx.lineWidth=size*.026;ctx.beginPath();
    ctx.moveTo(handle.x-uy*size*.045,handle.y+ux*size*.045);ctx.lineTo(handle.x+uy*size*.045,handle.y-ux*size*.045);ctx.stroke();
    if(tool.soil>0&&!carrying) {
      const load=point(-.065),amount=Math.max(0,Math.min(1,tool.soil));
      ctx.save();ctx.globalAlpha*=amount;ctx.fillStyle="#b5a77c";ctx.beginPath();ctx.ellipse(load.x,load.y,size*.047,size*.026,-.2,0,Math.PI*2);ctx.fill();
      if(frame.action==="shake")for(const n of [0,1,2]) {
        const fall=(1-amount)*size*(.10+n*.035);ctx.fillRect(load.x+side*size*(.025+n*.018),load.y+fall,size*.018,size*.014);
      }
      ctx.restore();
    }
  };
  const arms=()=>{gatheringArm(ctx,frame,-side,other,palette);gatheringArm(ctx,frame,side,main,palette);};
  const paws=()=>{ctx.fillStyle=rear?palette.moss:"#f4e4ae";for(const hand of [other,main]){ctx.beginPath();ctx.ellipse(hand.x,hand.y,size*.024,size*.025,0,0,Math.PI*2);ctx.fill();}};
  ctx.save();
  if(rear){arms();paintTool();paws();}
  drawGroundedHero(ctx,{x,y,size,pose:frame.pose,direction:frame.direction,frame:still?0:frame.frame,appearance,shadow,
    rig:{gardening:true,crouch:frame.crouch,lean:frame.lean}});
  if(!rear){arms();paintTool();paws();}
  ctx.restore();
}

/** Continuous shoulders→hands connect searching, lifting, packing and carrying;
 * the cached body supplies only the body and clothes, never duplicate arms. */
export function drawForestGatheringHero(ctx:CanvasRenderingContext2D, frame:ForestGatheringFrame,
  appearance?:{palette:string;head:string|null;neck:string|null},still=false,shadow=true) {
  const {x,y,size}=frame;
  if(![x,y,size].every(Number.isFinite)||size<=0)return;
  if(frame.tool==="shovel"){drawCoastalGatheringHero(ctx,frame,appearance,still,shadow);return;}
  const palette=mossPalette(appearance?.palette), arms=forestGatheringArms(frame,still), main=arms.holding.hand;
  const rear=frame.direction==="back";
  const prop=()=>{
    if(!frame.itemVisible)return;
    ctx.save();ctx.translate(main.x,main.y);
    if(frame.item==="twig") {ctx.strokeStyle="#7d5934";ctx.lineWidth=size*.036;ctx.beginPath();ctx.moveTo(-size*.04,size*.035);ctx.lineTo(size*.07,-size*.07);ctx.moveTo(size*.02,-size*.02);ctx.lineTo(size*.065,-size*.015);ctx.stroke();}
    else if(frame.item==="stone") {ctx.fillStyle="#c1c3a7";ctx.beginPath();ctx.ellipse(0,-size*.02,size*.055,size*.036,-.3,0,Math.PI*2);ctx.fill();}
    else {ctx.strokeStyle="#a9b376";ctx.lineWidth=size*.023;for(const dx of [-.03,0,.03]) {ctx.beginPath();ctx.moveTo(0,size*.02);ctx.lineTo(size*dx,-size*.07);ctx.stroke();}}
    ctx.restore();
  };
  const holding=()=>{
    basketArm(ctx,frame,arms.holding,palette);
    if(frame.held)drawForestGatheringBasket(ctx,frame);
    prop();
    // Draw the paw after the handle, but in the same depth layer as its arm.
    ctx.fillStyle=rear?palette.moss:"#f4e4ae";
    ctx.beginPath();ctx.ellipse(main.x,main.y,size*.026,size*.027,0,0,Math.PI*2);ctx.fill();
  };
  ctx.save();
  // The far arm is occluded by the body and clothing. It never joins the handle.
  basketArm(ctx,frame,arms.free,palette);
  if(rear)holding();
  drawGroundedHero(ctx,{x,y,size,pose:frame.pose,direction:frame.direction,frame:still?0:frame.frame,appearance,shadow,
    rig:{gardening:true,crouch:frame.crouch,lean:frame.lean}});
  if(!rear)holding();
  ctx.restore();
}
