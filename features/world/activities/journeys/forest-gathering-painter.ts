import { drawGroundedHero } from "@/features/world/scene/grounding";
import { heroSourceAnchor } from "@/features/world/scene/hero-anchors";
import { forestBasketArm } from "@/features/world/activities/garden/forest-basket-motion";
import { drawForestGardenBasket, drawForestGardenProps, drawGardenArms } from "@/features/world/activities/garden/forest-garden-painter";
import { coastalCarryShovel, type ForestGatheringFrame } from "./forest-gathering";
import { forestGatheringBasketVisual } from "./forest-gathering-rig";

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

function drawCoastalGatheringHero(ctx:CanvasRenderingContext2D,frame:ForestGatheringFrame,
  appearance:{palette:string;head:string|null;neck:string|null}|undefined,still:boolean,shadow:boolean) {
  const {x,y,size}=frame,side=frame.direction==="left"?-1:1,rear=frame.direction==="back";
  const carrying=frame.action==="walk"||frame.action==="ready";
  const tool=carrying||!frame.shovel ? coastalCarryShovel(side) : frame.shovel;
  const handle={x:x+size*tool.handle.x,y:y+size*tool.handle.y},blade={x:x+size*tool.blade.x,y:y+size*tool.blade.y};
  const dx=blade.x-handle.x,dy=blade.y-handle.y,length=Math.max(.001,Math.hypot(dx,dy)),ux=dx/length,uy=dy/length;
  const point=(along:number,across=0)=>({x:blade.x+size*(ux*along-uy*across),y:blade.y+size*(uy*along+ux*across)});
  const motion = { direction:frame.direction, pose:frame.pose, frame:still ? 0 : frame.frame };
  const shoulders = [14, 34].map(px => heroSourceAnchor(frame, { x:px + Math.round(frame.lean), y:31 + frame.crouch / 2 }, motion));
  const guide = { x:handle.x+dx*.51, y:handle.y+dy*.51 };
  // Each paw grips the end nearest its own shoulder, including the mirrored pose.
  const rig = { actor:frame, arms:shoulders.map((shoulder, index) => {
    const armSide = index ? 1 : -1;
    return forestBasketArm(shoulder, armSide === Math.sign(dx) ? guide : handle, armSide, size);
  }) };
  const paintTool=()=>{
    const neck = point(-.16);
    const edge = [point(0), point(-.025,.050), point(-.073,.080), point(-.16,.086), point(-.152,.028),
      point(-.195,.022), point(-.195,-.022), point(-.152,-.028), point(-.16,-.086), point(-.073,-.080), point(-.025,-.050)];
    ctx.lineCap="round";ctx.lineWidth=size*.045;ctx.strokeStyle="#513b29";
    ctx.beginPath();ctx.moveTo(handle.x,handle.y);ctx.lineTo(neck.x,neck.y);ctx.stroke();
    ctx.lineWidth=size*.024;ctx.strokeStyle="#bc915a";ctx.stroke();
    ctx.fillStyle="#536e68";ctx.strokeStyle="#344b48";ctx.lineWidth=size*.018;
    ctx.beginPath();ctx.moveTo(edge[0].x,edge[0].y);for(const p of edge.slice(1))ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();ctx.stroke();
    const ridge = point(-.14), rim = point(-.139,-.065), tip = point(-.024);
    ctx.fillStyle="#829c88"; ctx.beginPath(); ctx.moveTo(rim.x,rim.y); ctx.lineTo(ridge.x,ridge.y); ctx.lineTo(tip.x,tip.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle="#b7c5af"; ctx.lineWidth=size*.012; ctx.beginPath(); ctx.moveTo(ridge.x,ridge.y); ctx.lineTo(tip.x,tip.y); ctx.stroke();
    // A compact D grip, aligned with the shaft, remains visibly in the paw.
    ctx.strokeStyle="#735335";ctx.lineWidth=size*.026;ctx.beginPath();
    const gripWidth = size*.055;
    ctx.moveTo(handle.x-uy*gripWidth,handle.y+ux*gripWidth);
    ctx.lineTo(handle.x+uy*gripWidth,handle.y-ux*gripWidth);
    ctx.lineTo(handle.x+ux*size*.085,handle.y+uy*size*.085);
    ctx.closePath();ctx.stroke();
    if(tool.soil>0&&!carrying) {
      const load=point(-.065),amount=Math.max(0,Math.min(1,tool.soil));
      ctx.save();ctx.globalAlpha*=amount;ctx.fillStyle="#b5a77c";ctx.beginPath();ctx.ellipse(load.x,load.y,size*.047,size*.026,-.2,0,Math.PI*2);ctx.fill();
      if(frame.action==="shake")for(const n of [0,1,2]) {
        const fall=(1-amount)*size*(.10+n*.035);ctx.fillRect(load.x+side*size*(.025+n*.018),load.y+fall,size*.018,size*.014);
      }
      ctx.restore();
    }
  };
  const equipment = () => {
    drawGardenArms(ctx,rig);
    paintTool();
    drawGardenArms(ctx,rig,true);
  };
  ctx.save();
  if(rear)equipment();
  drawGroundedHero(ctx,{x,y,size,pose:frame.pose,direction:frame.direction,frame:still?0:frame.frame,appearance,shadow,
    rig:{gardening:true,crouch:frame.crouch,lean:frame.lean}});
  if(!rear)equipment();
  ctx.restore();
}

/** Continuous shoulders→hands connect searching, lifting, packing and carrying;
 * the cached body supplies only the body and clothes, never duplicate arms. */
export function drawForestGatheringHero(ctx:CanvasRenderingContext2D, frame:ForestGatheringFrame,
  appearance?:{palette:string;head:string|null;neck:string|null},still=false,shadow=true) {
  const {x,y,size}=frame;
  if(![x,y,size].every(Number.isFinite)||size<=0)return;
  if(frame.tool==="shovel"){drawCoastalGatheringHero(ctx,frame,appearance,still,shadow);return;}
  const visual = forestGatheringBasketVisual(frame, still), props = { ...visual, pickedBerry: null };
  const paintBasket = () => drawForestGatheringBasket(ctx, { ...frame, basket: visual.basket!, held: !visual.basket!.grounded });
  ctx.save();
  drawForestGardenProps(ctx, props, "behind", true, paintBasket);
  drawGroundedHero(ctx, { x, y, size, pose: visual.pose, direction: visual.direction, frame: visual.frame,
    appearance, shadow, rig: visual.rig });
  drawForestGardenProps(ctx, props, "front", true, paintBasket);
  const finding = visual.pickedBerry;
  if (finding) {
    ctx.save(); ctx.translate(finding.x, finding.y);
    if (frame.item === "twig") {
      ctx.strokeStyle = "#7d5934"; ctx.lineWidth = size * .025; ctx.beginPath();
      ctx.moveTo(-size * .025, size * .02); ctx.lineTo(size * .045, -size * .045);
      ctx.moveTo(size * .01, -size * .01); ctx.lineTo(size * .04, -size * .01); ctx.stroke();
    } else if (frame.item === "stone") {
      ctx.fillStyle = "#c1c3a7"; ctx.beginPath(); ctx.ellipse(0, 0, size * .035, size * .025, -.3, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = "#a9b376"; ctx.lineWidth = size * .018;
      for (const dx of [-.02, 0, .02]) { ctx.beginPath(); ctx.moveTo(0, size * .02); ctx.lineTo(size * dx, -size * .04); ctx.stroke(); }
    }
    ctx.restore();
  }
  ctx.restore();
}
