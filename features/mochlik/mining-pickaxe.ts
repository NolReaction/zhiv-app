/** A tapered, curved metal head and a wooden haft. The origin is the grip,
 * so walking changes the paw position without making the tool slide in it. */
export function drawMiningPickaxe(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number) {
  ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.scale(size/20,size/20);
  ctx.fillStyle = "#49382b"; ctx.fillRect(-1.5,-8,3,17);
  ctx.fillStyle = "#bf9255"; ctx.fillRect(-.5,-7,1,15);
  ctx.fillStyle = "#725036"; ctx.fillRect(-1.5,2,3,1); ctx.fillRect(-1.5,5,3,1);
  ctx.fillStyle = "#293d42"; ctx.beginPath();
  ctx.moveTo(-10,-4); ctx.lineTo(-7,-8); ctx.lineTo(-3,-10); ctx.lineTo(2,-10);
  ctx.lineTo(6,-8); ctx.lineTo(9,-4); ctx.lineTo(5,-6); ctx.lineTo(2,-7);
  ctx.lineTo(1,-5); ctx.lineTo(-2,-5); ctx.lineTo(-3,-7); ctx.lineTo(-6,-6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#a5bdc0"; ctx.beginPath();
  ctx.moveTo(-9,-5); ctx.lineTo(-6,-8); ctx.lineTo(-2,-9); ctx.lineTo(2,-9);
  ctx.lineTo(6,-7); ctx.lineTo(8,-5); ctx.lineTo(4,-7); ctx.lineTo(1,-7);
  ctx.lineTo(-2,-7); ctx.lineTo(-5,-7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#e4ebd8"; ctx.fillRect(-2,-9,4,1);
  ctx.fillStyle = "#697f83"; ctx.fillRect(-1,-8,2,3);
  ctx.restore();
}
