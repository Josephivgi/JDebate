"use strict";

// Blender for agents. Each jdebate MCP server process (one per agent session)
// gets its own Blender, started hidden in background mode with Blender Lab's
// MCP add-on (`blender --background --online-mode --command blender_mcp`).
// The add-on listens on a local TCP port and runs Python we send it:
// {"type":"execute","code":...,"strict_json":false} ended by a null byte, and
// answers with JSON ended by a null byte. No Blender window opens.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const START_TIMEOUT = 90000;
const RUN_TIMEOUT = 600000;

let proc = null; // { child, port, ready: Promise, log: string }

function findBlender() {
  if (process.env.JDEBATE_BLENDER && fs.existsSync(process.env.JDEBATE_BLENDER)) return process.env.JDEBATE_BLENDER;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean);
  const found = [];
  for (const r of roots) {
    const base = path.join(r, "Blender Foundation");
    let dirs = [];
    try {
      dirs = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const exe = path.join(base, d, "blender.exe");
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return found[0] || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function request(port, code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const chunks = [];
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error("Blender did not answer in " + Math.round(timeoutMs / 1000) + " s.")), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ type: "execute", code, strict_json: false }) + "\0"));
    sock.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      const z = buf.indexOf(0);
      if (z >= 0) {
        try {
          finish(null, JSON.parse(buf.subarray(0, z).toString("utf8")));
        } catch (e) {
          finish(e);
        }
      }
    });
    sock.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return finish(new Error("Blender closed the connection."));
      try {
        finish(null, JSON.parse(buf.toString("utf8").replace(/\0$/, "")));
      } catch (e) {
        finish(e);
      }
    });
    sock.on("error", (e) => finish(e));
  });
}

async function start() {
  if (proc && proc.child.exitCode === null) return proc.ready;
  const exe = findBlender();
  if (!exe) throw new Error("Blender is not installed. Install Blender 5.1 or newer, enable the MCP add-on from Blender Lab, or set JDEBATE_BLENDER to blender.exe.");
  const port = await freePort();
  const child = spawn(exe, ["--background", "--online-mode", "--command", "blender_mcp", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const p = { child, port, log: "", exe };
  const keep = (d) => {
    p.log = (p.log + d).slice(-6000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  p.ready = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < START_TIMEOUT) {
      if (child.exitCode !== null) throw new Error("Blender stopped while starting (exit " + child.exitCode + "):\n" + p.log.trim().slice(-1500) + "\nIs Blender Lab's MCP add-on installed and enabled?");
      try {
        await request(port, "result = {'ok': True}", 5000);
        return p;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    child.kill();
    throw new Error("Blender did not start in " + START_TIMEOUT / 1000 + " s.\n" + p.log.trim().slice(-1500));
  })();
  proc = p;
  child.on("exit", () => {
    if (proc === p) proc = null;
  });
  return p.ready;
}

function stop() {
  if (proc && proc.child.exitCode === null) proc.child.kill();
  proc = null;
}
process.on("exit", stop);

// Runs Python in Blender. Code sets `result = {...}` to send values back.
async function run(code, timeoutMs) {
  const p = await start();
  return request(p.port, String(code), timeoutMs || RUN_TIMEOUT);
}

const py = (v) => JSON.stringify(v); // JSON is valid Python for strings, numbers, lists

// Facts about the scene: every object with its size, triangles and material.
const SCENE_INFO = `
import bpy
objs = []
total = 0
for o in bpy.context.scene.objects:
    tris = 0
    if o.type == 'MESH':
        me = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        me.calc_loop_triangles()
        tris = len(me.loop_triangles)
        o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
        total += tris
    objs.append({'name': o.name, 'type': o.type, 'size_m': [round(x, 3) for x in o.dimensions], 'location': [round(x, 3) for x in o.location], 'tris': tris,
                 'materials': [s.material.name for s in getattr(o, 'material_slots', []) if s.material], 'parent': o.parent.name if o.parent else None})
result = {'file': bpy.data.filepath or '(not saved)', 'objects': objs, 'total_tris': total, 'meshes_over_roblox_limit': [o['name'] for o in objs if o['tris'] > 20000]}
`;

function sceneCode() {
  return SCENE_INFO;
}

function newSceneCode() {
  return `
import bpy
bpy.ops.wm.read_homefile(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'
result = {'ok': True, 'note': 'Empty scene. 1 Blender meter = 1 Roblox stud when exported at scale 1 and imported with the Roblox 3D Importer (studs).'}
`;
}

function openCode(file) {
  return `
import bpy
bpy.ops.wm.open_mainfile(filepath=${py(path.resolve(file))})
result = {'ok': True, 'file': bpy.data.filepath}
`;
}

// Renders the scene from several sides into PNGs. Frames every visible mesh,
// adds temporary lights when the scene has none, and removes them after.
function renderCode(folder, views, size, engine) {
  return `
import bpy, math, os
from mathutils import Vector
out = ${py(path.resolve(folder))}
os.makedirs(out, exist_ok=True)
views = ${py(views)}
size = ${py(size)}
sc = bpy.context.scene
meshes = [o for o in sc.objects if o.type in ('MESH', 'CURVE', 'META', 'FONT') and o.visible_get()]
if not meshes:
    raise RuntimeError('Nothing to render: the scene has no visible mesh objects.')
pts = []
for o in meshes:
    pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 0.01)
temp = []
def add(obj):
    sc.collection.objects.link(obj)
    temp.append(obj)
    return obj
cam_data = bpy.data.cameras.new('JD_Cam')
cam_data.lens = 50
cam_data.clip_end = max(1000.0, radius * 20)
cam = add(bpy.data.objects.new('JD_Cam', cam_data))
has_light = any(o.type == 'LIGHT' and o.visible_get() for o in sc.objects)
if not has_light:
    for name, energy, rot in (('JD_Key', 4.0, (50, 0, 35)), ('JD_Fill', 1.5, (60, 0, -130)), ('JD_Rim', 2.5, (120, 0, 180))):
        ld = bpy.data.lights.new(name, 'SUN')
        ld.energy = energy
        lo_ = add(bpy.data.objects.new(name, ld))
        lo_.rotation_euler = [math.radians(a) for a in rot]
world_made = False
if sc.world is None:
    sc.world = bpy.data.worlds.new('JD_World')
    world_made = True
sc.world.use_nodes = True
bg = sc.world.node_tree.nodes.get('Background')
old_bg = None
if bg:
    old_bg = (tuple(bg.inputs[0].default_value), bg.inputs[1].default_value)
    if world_made:
        bg.inputs[0].default_value = (0.32, 0.34, 0.38, 1)
        bg.inputs[1].default_value = 0.6
old = (sc.camera, sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath, sc.render.film_transparent)
sc.camera = cam
sc.render.resolution_x = size
sc.render.resolution_y = size
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
used = None
for eng in ${py(engine ? [engine] : ["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"])}:
    try:
        sc.render.engine = eng
        used = eng
        break
    except Exception:
        pass
if used == 'BLENDER_WORKBENCH':
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'MATERIAL'
dirs = {'front': (0, -1, 0.18), 'back': (0, 1, 0.18), 'left': (-1, 0, 0.18), 'right': (1, 0, 0.18), 'side': (1, 0, 0.18),
        'three_quarter': (0.75, -1, 0.45), 'top': (0.001, -0.001, 1), 'low': (0.6, -1, -0.05)}
fov = 2 * math.atan(36 / (2 * cam_data.lens))
dist = radius / math.sin(fov / 2) * 1.08
files = []
try:
    for v in views:
        d = Vector(dirs.get(v, dirs['three_quarter'])).normalized()
        cam.location = center + d * dist
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
        path = os.path.join(out, v + '.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
finally:
    sc.camera, eng0, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath, sc.render.film_transparent = old
    try:
        sc.render.engine = eng0
    except Exception:
        pass
    for o in temp:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if isinstance(data, bpy.types.Camera):
            bpy.data.cameras.remove(data)
        elif isinstance(data, bpy.types.Light):
            bpy.data.lights.remove(data)
    if world_made:
        bpy.data.worlds.remove(sc.world)
result = {'files': files, 'engine': used, 'size_m': [round(x, 3) for x in (hi - lo)]}
`;
}

// Exports the scene for JDebate and Roblox: .glb (the 3D viewer), .fbx and
// .obj (Roblox 3D Importer), .blend (the source).
function exportCode(folder, name, formats) {
  return `
import bpy, os
out = ${py(path.resolve(folder))}
os.makedirs(out, exist_ok=True)
name = ${py(name)}
formats = ${py(formats)}
files = []
for o in list(bpy.context.scene.objects):
    if o.name.startswith('JD_'):
        bpy.data.objects.remove(o, do_unlink=True)
if 'glb' in formats:
    p = os.path.join(out, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', use_selection=False, export_apply=True, export_yup=True)
    files.append(p)
if 'fbx' in formats:
    p = os.path.join(out, name + '.fbx')
    bpy.ops.export_scene.fbx(filepath=p, use_selection=False, apply_scale_options='FBX_SCALE_ALL', use_mesh_modifiers=True, axis_forward='-Z', axis_up='Y', bake_space_transform=True, path_mode='COPY', embed_textures=True)
    files.append(p)
if 'obj' in formats:
    p = os.path.join(out, name + '.obj')
    bpy.ops.wm.obj_export(filepath=p, export_selected_objects=False, apply_modifiers=True, export_materials=True, forward_axis='NEGATIVE_Z', up_axis='Y')
    files.append(p)
if 'blend' in formats:
    p = os.path.join(out, name + '.blend')
    bpy.ops.wm.save_as_mainfile(filepath=p, copy=True)
    files.append(p)
${SCENE_INFO.replace("result = {", "info = {")}
result = {'files': files, 'total_tris': info['total_tris'], 'meshes_over_roblox_limit': info['meshes_over_roblox_limit'], 'objects': len(info['objects'])}
`;
}

const status = () => ({ exe: findBlender(), running: Boolean(proc && proc.child.exitCode === null), port: proc ? proc.port : null });

module.exports = { run, start, stop, status, findBlender, sceneCode, newSceneCode, openCode, renderCode, exportCode };
