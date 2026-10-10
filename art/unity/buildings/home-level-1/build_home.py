"""Original editable level-one stump home. Blender 4.5 LTS, no external assets.

Run in Blender: blender --background --python build_home.py -- --render
The authoring scene stays outside Assets; Unity receives FBX + one colour atlas.
Blender coordinates: Z up, entrance -Y. DoorAnchor makes Unity orientation explicit.
Re-running writes the generated model/atlas/master, never a Unity scene or prefab.
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[4]
SOURCE = Path(__file__).resolve().parent
ASSETS = ROOT / "apps/unity/Assets/_Project/Art/Buildings/HomeLevel1"
random.seed(17)
MODEL = []


def make_atlas():
    """Paint UV islands mathematically; grain is in the shipped diffuse texture."""
    import numpy as np
    from PIL import Image
    size = 1024
    # Array y is flipped below so these are conventional bottom-left UV regions.
    yy, xx = np.mgrid[0:size, 0:size].astype(float) / size
    image = np.zeros((size, size, 3), dtype=float)
    rng = np.random.default_rng(17)
    noise = rng.normal(0, 1.3, (size, size))
    # Left half: fissured oak bark, broad tonal ridges with fine vertical grain.
    u = xx * 2
    bend = u + .012*np.sin(yy*9+u*31) + .003*np.sin(yy*37+u*53)
    ridges = np.sin(bend*math.tau*31) + .35*np.sin(bend*math.tau*63)
    grooves = np.maximum(0, np.cos(bend*math.tau*31))**12
    grain = 3*np.sin(bend*math.tau*213 + .7*np.sin(yy*27))
    short_cracks = np.maximum(0,np.cos(yy*math.tau*19+np.floor(u*46)*2.41))**45
    short_cracks *= .35+.65*np.maximum(0,np.sin(u*89+yy*31))
    shade = ridges*6 - grooves*24 - short_cracks*9 + grain + 5*np.sin(yy*4+u*13) + noise
    for c, base in enumerate((103, 77, 48)):
        image[:, :, c] = base + shade*(1 if c == 0 else .8)
    # Upper-right quarter: eccentric, broken annual rings of the exposed cut.
    x, y = (xx-.75)*4, (yy-.75)*4
    radius = np.sqrt((x-.055)**2 + ((y+.035)*1.035)**2)
    theta = np.arctan2(y, x)
    rings = radius*20 + .12*np.sin(theta*5+radius*9) + .05*np.sin(theta*11)
    fine = np.maximum(0, np.cos(rings*math.tau))**9
    split = np.zeros_like(radius)
    for angle, start, width in ((.32,.3,.008),(2.7,.5,.011),(-1.65,.18,.007)):
        diff = np.arctan2(np.sin(theta-angle), np.cos(theta-angle))
        split += np.exp(-(diff/width)**2)*(radius>start)*22
    shade = -fine*24 - split + 5*np.sin(radius*11) + noise
    cut = (xx >= .5) & (yy >= .5)
    for c, base in enumerate((163, 128, 81)):
        image[:, :, c][cut] = (base + shade*(1 if c == 0 else .7))[cut]
    # Lower-right left strip: matte moss, tonal patches rather than green balls.
    moss = (xx >= .5) & (xx < .75) & (yy < .5)
    shade = 4*np.sin(xx*31+np.sin(yy*23)) + noise*4
    for c, base in enumerate((68, 87, 38)):
        image[:, :, c][moss] = (base+shade)[moss]
    # Lower-right right strip: worn interior planks.
    plank = (xx >= .75) & (yy < .35)
    shade = 5*np.sin(xx*710+yy*8)+3*np.sin(xx*2130+yy*19)+noise
    for c, base in enumerate((128, 92, 53)):
        image[:, :, c][plank] = (base+shade)[plank]
    # Small constant swatches: bronze, stone, dark recess, leaf underside.
    for i, colour in enumerate(((62,58,41),(120,117,93),(35,27,19),(72,84,41))):
        region = (xx >= .75+i*.0625) & (xx < .75+(i+1)*.0625) & (yy>=.35) & (yy<.5)
        image[region] = colour
    ASSETS.mkdir(parents=True, exist_ok=True)
    # A compact colour atlas is sufficient at the portrait camera distance.
    Image.fromarray(np.clip(image[::-1],0,255).astype('uint8')).quantize(colors=128).convert('RGB').save(ASSETS/'HomeLevel1_Albedo.png',optimize=True)


def material():
    atlas = bpy.data.images.load(str(ASSETS/'HomeLevel1_Albedo.png'), check_existing=True)
    atlas.colorspace_settings.name = 'sRGB'
    mat = bpy.data.materials.new('HomeSurface')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = .82
    bsdf.inputs['Specular IOR Level'].default_value = .24
    texture = mat.node_tree.nodes.new('ShaderNodeTexImage')
    texture.image = atlas
    mat.node_tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    # Subtle grain in the studio render; Unity uses the same colour atlas and geometry.
    bump = mat.node_tree.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .16
    bump.inputs['Distance'].default_value = .026
    mat.node_tree.links.new(texture.outputs['Color'], bump.inputs['Height'])
    mat.node_tree.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    glow = bpy.data.materials.new('HomeGlow')
    glow.use_nodes = True
    bsdf = glow.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (.8,.39,.10,1)
    bsdf.inputs['Roughness'].default_value = .55
    bsdf.inputs['Emission Color'].default_value = (1,.51,.14,1)
    bsdf.inputs['Emission Strength'].default_value = 2
    return mat, glow


def mesh(name, verts, faces, uv=None, smooth=True):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(SURFACE)
    layer = data.uv_layers.new(name='UVMap')
    for face in data.polygons:
        face.use_smooth = smooth
        for loop in face.loop_indices:
            v = data.loops[loop].vertex_index
            layer.data[loop].uv = uv[v] if uv else (.9,.4)
    MODEL.append(obj)
    return obj


def swatch(obj, index):
    for loop in obj.data.uv_layers.active.data:
        loop.uv = (.75+index*.0625+.03125,.425)


def cube(name, loc, scale, kind='plank', bevel=.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj=bpy.context.object
    obj.name=name
    obj.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.data.materials.append(SURFACE)
    MODEL.append(obj)
    uv=obj.data.uv_layers.active
    for point in uv.data:
        if kind=='plank':point.uv=(.76+point.uv.x*.22,.02+point.uv.y*.3)
    if kind!='plank':swatch(obj, {'bronze':0,'stone':1,'dark':2}[kind])
    if bevel:
        mod=obj.modifiers.new('Hand worn edges','BEVEL');mod.width=bevel;mod.segments=2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def tube(name, points, radii, sides=10, kind='bark'):
    verts=[];uv=[];faces=[]
    for i,(point,radius) in enumerate(zip(points,radii)):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        tangent.normalize()
        guide=Vector((0,0,1)) if abs(tangent.z)<.85 else Vector((0,1,0))
        u=tangent.cross(guide).normalized();v=tangent.cross(u).normalized()
        for j in range(sides+1):
            a=j*math.tau/sides
            pos=Vector(point)+u*math.cos(a)*radius+v*math.sin(a)*radius
            verts.append(tuple(pos))
            uv.append((j/sides*.49,i/(len(points)-1)*.97))
    for i in range(len(points)-1):
        for j in range(sides):
            a=i*(sides+1)+j;b=a+sides+1
            faces.append((a,a+1,b+1,b))
    faces.extend([tuple(range(sides-1,-1,-1)),tuple((len(points)-1)*(sides+1)+j for j in range(sides))])
    obj=mesh(name,verts,faces,uv)
    if kind=='bronze':swatch(obj,0)
    return obj


def crown_height(a):return 2.68+.065*math.sin(a*3+.7)+.038*math.sin(a*7)


def trunk_radius(a,t):
    return (1.28-.10*t+.035*math.sin(t*7+a*3)+.065*math.sin(a*7+t*.8)+.033*math.sin(a*19+t*3))


def stump():
    sides=96;levels=15;verts=[];uv=[];faces=[]
    for k in range(levels+1):
        t=k/levels
        for j in range(sides+1):
            a=j*math.tau/sides;r=trunk_radius(a,t)
            verts.append((r*math.cos(a)+.04*t,r*math.sin(a)+.02*t,crown_height(a)*t))
            uv.append((j/sides*.496,.008+t*.984))
    for k in range(levels):
        for j in range(sides):
            a=k*(sides+1)+j;b=a+sides+1
            faces.append((a,a+1,b+1,b))
    faces.append(tuple(range(sides-1,-1,-1)))
    faces.append(tuple(levels*(sides+1)+j for j in range(sides)))
    body=mesh('Ancient oak — carved shelter',verts,faces,uv)
    # An actual doorway, not a dark rectangle glued to an unbroken cylinder.
    contour=[(-.52,-.16),(.52,-.16),(.52,1.40)]
    contour += [(.52*math.cos(i*math.pi/16),1.40+.52*math.sin(i*math.pi/16)) for i in range(1,17)]
    contour += [(-.52,-.16)]
    contour=contour[:-1]
    n=len(contour)
    cutter=mesh('Temporary arch cutter',[(x,y,z) for y in (-2,.16) for x,z in contour],
                [tuple(range(n)),tuple(range(2*n-1,n-1,-1))]+[(i+n,(i+1)%n+n,(i+1)%n,i) for i in range(n)],smooth=False)
    bpy.context.view_layer.objects.active=body
    mod=body.modifiers.new('Hollow arched entry','BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    MODEL.remove(cutter);bpy.data.objects.remove(cutter,do_unlink=True)
    # Endgrain follows the ragged crown but remains a broad readable surface.
    verts=[(.04,.02,2.682)];uv=[(.75,.75)];faces=[]
    for j in range(sides):
        a=j*math.tau/sides;r=trunk_radius(a,1)-.045
        verts.append((r*math.cos(a)+.04,r*math.sin(a)+.02,crown_height(a)+.008))
        uv.append((.75+.24*math.cos(a),.75+.24*math.sin(a)))
    for j in range(sides):faces.append((0,1+j,1+(j+1)%sides))
    mesh('Uneven cut — annual rings',verts,faces,uv,smooth=False)
    # Roots hug the earth and leave a clean approach to the arch.
    for i,a in enumerate((.1,.9,1.8,2.7,3.6,5.5)):
        start=Vector((math.cos(a),math.sin(a),0))
        points=[tuple(start*.84+Vector((0,0,.72))),tuple(start*1.12+Vector((0,0,.30))),
                tuple(start*1.40+Vector((0,0,.13))),tuple(start*1.64+Vector((0,0,.085)))]
        tube('Buttress root %02d'%i,points,[.26,.24,.15,.065],12)
    # Quiet dark interior with separate real planks and a threshold.
    for i in range(5):
        cube('Interior floor plank %d'%i,(-.43+i*.214,-.55,.07),(.205,1.25,.12),bevel=.008)
    cube('Shelter back wall',(0,.14,.92),(1.02,.04,1.72),'dark',.005)
    for i in range(6):
        cube('Interior vertical oak %d'%i,(-.45+i*.18,.112,.90),(.17,.025,1.68),bevel=.01)
    # Chunky little stepping stone, within the reserved collider footprint.
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1,location=(0,-1.46,.08))
    stone=bpy.context.object;stone.name='Entry stone';stone.scale=(.59,.24,.09)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    stone.data.materials.append(SURFACE);MODEL.append(stone);swatch(stone,1)
    for p in stone.data.polygons:p.use_smooth=True


def moss_patch(name, center, radius, vertical=False):
    # Broad wrinkled patch with a thin profile; no faceted green sphere piles.
    sides=24
    peak=Vector(center)+Vector((0,-.025,.030) if vertical else (0,0,.030))
    verts=[tuple(peak)];uv=[(.625,.25)];faces=[]
    phase=random.uniform(0,math.tau)
    for j in range(sides):
        a=j*math.tau/sides;r=radius*(.90+.075*math.sin(a*3+phase)+random.uniform(-.055,.055))
        if vertical:
            x=center[0]+r*math.cos(a)*.62;z=center[2]+r*math.sin(a)
            # Front moss conforms to the trunk face.
            y=center[1]-.012-.028*math.sin(a*3)
        else:
            x=center[0]+r*math.cos(a);y=center[1]+r*math.sin(a)
            z=center[2]-.015+.012*math.sin(a*3+phase)
        verts.append((x,y,z));uv.append((.625+.10*math.cos(a),.25+.20*math.sin(a)))
    for j in range(sides):faces.append((0,1+j,1+(j+1)%sides))
    obj=mesh(name,verts,faces,uv)
    sol=obj.modifiers.new('Thin moss mat','SOLIDIFY');sol.thickness=.024
    bpy.context.view_layer.objects.active=obj;bpy.ops.object.modifier_apply(modifier=sol.name)
    return obj


def moss_sprigs(center, radius, count):
    verts=[];faces=[];uv=[]
    for _ in range(count):
        a=random.uniform(0,math.tau);r=radius*math.sqrt(random.random())*.72
        base=Vector(center)+Vector((r*math.cos(a),r*math.sin(a),.03))
        for leaf in range(3):
            ang=a+leaf*math.tau/3;direction=Vector((math.cos(ang),math.sin(ang),0))
            side=Vector((-direction.y,direction.x,0))
            length=random.uniform(.042,.077)
            tip=base+direction*length+Vector((0,0,.025))
            mid=base.lerp(tip,.55)+Vector((0,0,.020))
            start=len(verts)
            verts.extend([tuple(base),tuple(mid+side*length*.29),tuple(tip),tuple(mid-side*length*.29),tuple(mid+Vector((0,0,.010)))])
            uv.extend([(.63,.05),(.54,.25),(.63,.46),(.72,.25),(.63,.25)])
            faces.extend([(start,start+1,start+4),(start+1,start+2,start+4),(start+2,start+3,start+4),(start+3,start,start+4)])
    mesh('Fine moss shoots',verts,faces,uv)


def moss_and_sprout():
    for i,(a,radius) in enumerate(((.2,.32),(.7,.28),(1.3,.33),(1.9,.30),(2.3,.36),(2.8,.29),(3.4,.32),(4.0,.26),(5.5,.32),(5.9,.24))):
        r=.97
        center=(r*math.cos(a)+.04,r*math.sin(a)+.02,crown_height(a)+.030)
        moss_patch('Crown moss %02d'%i,center,radius)
        moss_sprigs(center,radius,14)
    for i,a in enumerate((.1,.9,1.8,2.7,3.6,5.5)):
        center=(1.36*math.cos(a),1.36*math.sin(a),.20)
        moss_patch('Moss at root %02d'%i,center,.20)
        moss_sprigs(center,.20,5)
    # A few small cascading clumps follow the actual bark, not a flat hanging sheet.
    for side in (-1,1):
        a=4.71+side*.69
        for j in range(5):
            z=2.66-j*.14;r=trunk_radius(a,z/2.68)+.025
            moss_patch('Trailing moss',(r*math.cos(a),r*math.sin(a),z),.105-j*.012,True)
    # Crown crack grooves have thickness in geometry, so read in distant shots.
    for i,a in enumerate((.35,2.65,4.65)):
        start=.36 if i==2 else .55
        points=[(.04+r*math.cos(a+.025*math.sin(r*7)),.02+r*math.sin(a+.025*math.sin(r*7)),2.695) for r in (start,.72,.99)]
        crack=tube('Split in the cut',points,[.012,.016,.008],5);swatch(crack,2)
    tube('New oak shoot',[(.65,.43,2.73),(.68,.42,3.03),(.77,.46,3.34),(.84,.43,3.56)],[.055,.044,.028,.012],10)
    for i,(base,tip,width) in enumerate((((.72,.44,3.18),(.40,.38,3.40),.17),((.77,.46,3.35),(1.03,.48,3.62),.16),((.66,.42,3.02),(.99,.33,3.16),.18))):
        b=Vector(base);t=Vector(tip);mid=b.lerp(t,.52);side=Vector((0,1,0))
        verts=[];uv=[];faces=[]
        for k in range(9):
            f=k/8
            center=b.lerp(t,f)+Vector((0,0,.025*math.sin(f*math.pi)))
            span=width*math.sin(f*math.pi)**.8*(.8+.2*math.cos(f*math.pi*8))
            for offset in (-1,0,1):
                verts.append(tuple(center+side*offset*span+Vector((0,0,.022*(1-abs(offset))*math.sin(f*math.pi)))))
                uv.append((.625+offset*.10,.05+f*.40))
            if k:
                a=(k-1)*3;bindex=k*3
                faces.extend([(a,bindex,bindex+1,a+1),(a+1,bindex+1,bindex+2,a+2)])
        leaf=mesh('Oak leaf %d'%i,verts,faces,uv)
        sol=leaf.modifiers.new('Leaf underside','SOLIDIFY');sol.thickness=.006
        bpy.context.view_layer.objects.active=leaf;bpy.ops.object.modifier_apply(modifier=sol.name)
        tube('Leaf rib',[base,tuple(mid+Vector((0,0,.05))),tip],[.008,.006,.002],5)


def lantern():
    x,y,z=.77,-1.02,1.42
    tube('Forged lantern hook',[(x,y+.06,z+.53),(x,y-.12,z+.56),(x,y-.24,z+.48),(x,y-.24,z+.40)],[.028]*4,8,'bronze')
    for height,r in ((z-.26,.18),(z+.22,.16)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=r,depth=.06,location=(x,y-.25,height))
        obj=bpy.context.object;obj.name='Lantern bronze cap';obj.data.materials.append(SURFACE);MODEL.append(obj);swatch(obj,0)
    glass=cube('Lantern amber glass',(x,y-.25,z-.015),(.22,.22,.42),'bronze',.01)
    glass.data.materials.clear();glass.data.materials.append(GLOW)
    for dx,dy in ((-.14,-.14),(.14,-.14),(.14,.14),(-.14,.14)):
        tube('Lantern cage',[(x+dx,y-.25+dy,z-.25),(x+dx,y-.25+dy,z+.22)],[.018,.018],6,'bronze')
    tube('Lantern bail',[(x-.1,y-.25,z+.23),(x-.09,y-.25,z+.38),(x,y-.25,z+.42),(x+.09,y-.25,z+.38),(x+.1,y-.25,z+.23)],[.017]*5,8,'bronze')


def finish_export():
    # Flatten only game meshes to one ground-pivot object / two material slots.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in MODEL:obj.select_set(True)
    bpy.context.view_layer.objects.active=MODEL[0]
    bpy.ops.object.join();obj=bpy.context.object;obj.name='HomeLevel1'
    bpy.context.scene.cursor.location=(0,0,0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    # Leaf tips meet at a single point: weld them before triangulating.
    import bmesh
    bm=bmesh.new();bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.000001)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=.000001)
    bm.to_mesh(obj.data);bm.free();obj.data.update()
    # Remove redundant material slots introduced by the joins.
    bpy.ops.object.material_slot_remove_unused()
    tri=obj.modifiers.new('Game triangles','TRIANGULATE')
    bpy.ops.object.modifier_apply(modifier=tri.name)
    for name,pos in (('GroundOrigin',(0,0,0)),('DoorAnchor',(0,-1.27,.18))):
        marker=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(marker);marker.location=pos;marker.select_set(True)
    obj.select_set(True)
    bpy.ops.export_scene.fbx(filepath=str(ASSETS/'HomeLevel1.fbx'),use_selection=True,
        object_types={'MESH','EMPTY'},global_scale=1,apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_ALL',axis_forward='-Z',axis_up='Y',
        bake_space_transform=True,use_mesh_modifiers=True,mesh_smooth_type='OFF',
        use_triangles=True,bake_anim=False,add_leaf_bones=False,path_mode='STRIP')
    coords=[v.co for v in obj.data.vertices]
    lo=[min(v[i] for v in coords) for i in range(3)];hi=[max(v[i] for v in coords) for i in range(3)]
    stats={'blender':bpy.app.version_string,'triangles':len(obj.data.polygons),'vertices':len(obj.data.vertices),
           'materials':[m.name for m in obj.data.materials], 'blender_bounds_min':lo,'blender_bounds_max':hi,
           'entrance':'Blender -Y; Unity preview aligns DoorAnchor to -Z',
           'atlas':'1024x1024 sRGB; one opaque atlas; HomeGlow emissive slot', 'external_assets':False}
    (SOURCE/'model-info.json').write_text(json.dumps(stats,indent=2)+'\n')
    print('HOME MODEL',json.dumps(stats))
    return obj


def studio(obj):
    scene=bpy.context.scene
    scene.render.engine='CYCLES';scene.cycles.samples=48
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1100;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='JPEG';scene.render.image_settings.quality=94
    scene.world=bpy.data.worlds.new('Forest studio')
    scene.world.color=(.15,.15,.15)
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.29,.34,.25,1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.4
    scene.view_settings.view_transform='AgX'
    scene.render.film_transparent=False
    # A studio ground is deliberately excluded from the FBX export.
    groundmat=bpy.data.materials.new('Studio earth');groundmat.diffuse_color=(.115,.145,.08,1);groundmat.use_nodes=True
    groundmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.115,.145,.08,1)
    groundmat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=1
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.045));ground=bpy.context.object;ground.name='Studio — not exported';ground.data.materials.append(groundmat)
    def light(name,loc,power,size,colour):
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=colour
        item=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(item);item.location=loc
        item.rotation_euler=(Vector((0,0,1.3))-item.location).to_track_quat('-Z','Y').to_euler()
    light('Soft morning',(-3,-4,7),800,5,(1,.85,.64))
    light('Forest fill',(4,-1,4),380,4,(.69,.80,.67))
    light('Crown rim',(1,4,5),600,3,(1,.82,.54))
    data=bpy.data.lights.new('Lantern light','POINT');data.energy=5;data.color=(1,.52,.18);data.shadow_soft_size=.15
    lamp=bpy.data.objects.new('Lantern light',data);bpy.context.collection.objects.link(lamp);lamp.location=(.77,-1.41,1.4)
    camera=bpy.data.cameras.new('Game angle 45 degrees');camera.type='ORTHO';camera.ortho_scale=5.6
    cam=bpy.data.objects.new('Game angle 45 degrees',camera);bpy.context.collection.objects.link(cam)
    target=Vector((0,0,1.5));cam.location=target+Vector((-5,-5,math.sqrt(50)))
    cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();scene.camera=cam
    atlas=bpy.data.images.get('HomeLevel1_Albedo.png')
    if atlas:atlas.pack()
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'HomeLevel1.blend'),compress=True)
    return scene


def main():
    global SURFACE,GLOW
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    parser=argparse.ArgumentParser();parser.add_argument('--render',action='store_true');args=parser.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system='METRIC';bpy.context.scene.unit_settings.scale_length=1
    make_atlas();SURFACE,GLOW=material();stump();moss_and_sprout();lantern();obj=finish_export();scene=studio(obj)
    if args.render:
        scene.render.filepath=str(SOURCE/'HomeLevel1-preview.jpg');bpy.ops.render.render(write_still=True)


if __name__=='__main__':main()
