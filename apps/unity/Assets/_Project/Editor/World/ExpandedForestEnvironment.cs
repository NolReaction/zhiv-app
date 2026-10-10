using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using Zhiv.WorldPrototype;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    public sealed class ExpandedForestEnvironmentResult
    {
        public Transform Root;
        public Transform Coast;
        public Transform WaterAnchor;
        public int TreeCount;
        public int EditableTreeCount;
        public int ForestPatchCount;
        public int WaterColliderCount;
    }

    /// <summary>
    /// One-time population of the large landscape. Near-path trees remain prefab instances;
    /// the deep woods use persistent combined meshes in separately movable twelve-metre patches.
    /// There is no scatter generator or asset mutation in the running game.
    /// </summary>
    public static class ExpandedForestEnvironment
    {
        private const int ObstacleLayer = 9;
        private const float TreeSpacing = 3.15f;
        private const float PatchSize = 12f;
        private const int EditableTreeLimit = 420;
        private const int TreeLimit = 8200;

        public static ExpandedForestEnvironmentResult Build(Terrain terrain, GroundRecipe recipe,
            PrototypeArtSet art, Transform parent, string assetFolder)
        {
            if (terrain == null || terrain.terrainData == null || recipe == null || art == null ||
                art.Tree == null || art.Rock == null || art.Water == null)
                throw new ArgumentException("A baked Terrain, recipe and persistent forest art are required.");
            if (!AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for the forest meshes first.", nameof(assetFolder));

            var result = new ExpandedForestEnvironmentResult { Root = Group("Forest and coast", parent) };
            var random = new System.Random(recipe.Seed + 971);
            var paths = new GroundPathMath(recipe);
            var palette = new TreePalette(art.Tree, assetFolder);
            var candidates = CreateTreePlacements(terrain, recipe, paths, random);
            Shuffle(candidates, random);

            Transform individualTrees = Group("Forest edges - editable tree prefabs", result.Root);
            Transform patchRoot = Group("Deep woods - combined 12m patches", result.Root);
            var patches = new Dictionary<Vector2Int, ForestPatch>();
            foreach (TreePlacement tree in candidates)
            {
                if (result.TreeCount >= TreeLimit) break;
                result.TreeCount++;
                if (tree.NearTrail && result.EditableTreeCount < EditableTreeLimit)
                {
                    GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(art.Tree, individualTrees);
                    instance.name = "Edge tree " + (++result.EditableTreeCount).ToString("000");
                    instance.transform.SetPositionAndRotation(tree.Position, tree.Rotation);
                    instance.transform.localScale = tree.Scale;
                    continue;
                }

                var key = new Vector2Int(Mathf.FloorToInt(tree.Position.x / PatchSize),
                    Mathf.FloorToInt(tree.Position.z / PatchSize));
                if (!patches.TryGetValue(key, out ForestPatch patch))
                {
                    patch = new ForestPatch(key, patchRoot, palette.Materials.Length);
                    patches.Add(key, patch);
                }
                patch.AddTree(tree, palette);
            }
            foreach (ForestPatch patch in patches.Values)
            {
                patch.SaveMesh(assetFolder, palette.Materials);
                result.ForestPatchCount++;
            }

            CreateCoast(terrain, recipe, art.Water, result, assetFolder);
            PopulateGroundDetails(terrain, recipe, art, palette, paths, result.Root, random);
            AssetDatabase.SaveAssets();
            return result;
        }

        private static List<TreePlacement> CreateTreePlacements(Terrain terrain, GroundRecipe recipe,
            GroundPathMath paths, System.Random random)
        {
            var result = new List<TreePlacement>();
            // A jittered lattice makes continuous woodland, with deliberately cut-out clearings
            // and routes. Filling the complete physical terrain also supplies the camera backdrop.
            int row = 0;
            for (float z = recipe.Origin.z + 3; z < recipe.Origin.z + recipe.Size.z - 3; z += TreeSpacing, row++)
            for (float x = recipe.Origin.x + 3; x < recipe.Origin.x + recipe.Size.x - 3; x += TreeSpacing)
            {
                var point = new Vector2(x + (row % 2 == 0 ? 0 : TreeSpacing * .5f) + Next(random, -.48f, .48f),
                    z + Next(random, -.48f, .48f));
                float scale = Next(random, 1.24f, 1.66f);
                float crown = scale * 1.3f;
                if (!CanPlace(point, crown, terrain, paths)) continue;

                Vector2 mapPoint = ExpandedForestDefinition.ToMapXZ(point);
                Rect bounds = ExpandedForestDefinition.PlayableMapBounds;
                bool inhabited = mapPoint.x >= bounds.xMin - 3 && mapPoint.x <= bounds.xMax + 3 &&
                    mapPoint.y >= bounds.yMin - 3 && mapPoint.y <= bounds.yMax + 3;
                bool near = inhabited && (ExpandedForestDefinition.InClearing(point, crown + 5) ||
                    TouchesTrail(paths, point, crown + 4.5f));
                result.Add(new TreePlacement
                {
                    Position = GroundPoint(terrain, point),
                    Rotation = Quaternion.Euler(0, Next(random, 0, 360), 0),
                    Scale = new Vector3(scale * Next(random, .9f, 1.1f), scale * Next(random, .9f, 1.12f), scale),
                    NearTrail = near,
                    HasCollider = inhabited
                });
            }
            return result;
        }

        private static bool CanPlace(Vector2 point, float radius, Terrain terrain, GroundPathMath paths)
        {
            if (ExpandedForestDefinition.InClearing(point, radius + .5f) ||
                paths.IsWater(point, radius + 1f) || TouchesTrail(paths, point, radius + .65f)) return false;
            // At the fixed 45-degree pitch a crown is projected beyond its trunk. Reserve that
            // footprint too, so dense trees in front of a path do not conceal the walking strip.
            Vector2 crownProjection = point + ExpandedForestDefinition.ToWorldXZ(new Vector2(0, 6f));
            if (TouchesTrail(paths, crownProjection, radius) ||
                ExpandedForestDefinition.InClearing(crownProjection, radius)) return false;
            return GroundPoint(terrain, point).y > ExpandedForestDefinition.WaterHeight + .1f;
        }

        private static bool TouchesTrail(GroundPathMath paths, Vector2 point, float radius)
        {
            if (paths.SamplePathWeight(point) > .01f) return true;
            for (int i = 0; i < 16; i++)
            {
                float angle = i * Mathf.PI * 2 / 16;
                if (paths.SamplePathWeight(point + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius) > .01f)
                    return true;
            }
            return false;
        }

        internal static void CreateCoast(Terrain terrain, GroundRecipe recipe, Material material,
            ExpandedForestEnvironmentResult result, string folder)
        {
            result.Coast = Group("Coast - open water beyond the southern shore", result.Root);
            Transform surface = Group("Continuous water surface", result.Coast);
            surface.position = new Vector3(recipe.Origin.x, ExpandedForestDefinition.WaterHeight, recipe.Origin.z);
            // Land hides this single plane; carving the shoreline reveals water without seams or
            // overlapping coplanar water polygons. The plane covers the camera's full terrain buffer.
            var mesh = new Mesh
            {
                name = "Open coastal water",
                vertices = new[] { Vector3.zero, new Vector3(recipe.Size.x, 0, 0),
                    new Vector3(0, 0, recipe.Size.z), new Vector3(recipe.Size.x, 0, recipe.Size.z) },
                uv = new[] { Vector2.zero, new Vector2(recipe.Size.x / 12, 0),
                    new Vector2(0, recipe.Size.z / 12), new Vector2(recipe.Size.x / 12, recipe.Size.z / 12) },
                triangles = new[] { 0, 2, 1, 1, 2, 3 }
            };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            SaveMesh(mesh, folder, "CoastalWater");
            surface.gameObject.AddComponent<MeshFilter>().sharedMesh = mesh;
            MeshRenderer renderer = surface.gameObject.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = true;

            Transform blockers = Group("Water volumes - convex shoreline pieces", result.Coast);
            foreach (GroundWaterRegion region in recipe.WaterRegions)
            {
                List<Vector2> polygon = CleanPolygon(region.Points);
                List<int> triangles = Triangulate(polygon);
                for (int i = 0; i < triangles.Count; i += 3)
                {
                    Vector2 a = polygon[triangles[i]], b = polygon[triangles[i + 1]], c = polygon[triangles[i + 2]];
                    Vector2 center = (a + b + c) / 3;
                    if (result.WaterAnchor == null)
                    {
                        result.WaterAnchor = Group("Water view anchor", result.Coast);
                        result.WaterAnchor.position = new Vector3(center.x, region.WaterHeight, center.y);
                    }
                    string id = (++result.WaterColliderCount).ToString("000");
                    Transform obstacle = Group("Water volume " + id, blockers);
                    obstacle.position = new Vector3(center.x, 0, center.y);
                    obstacle.gameObject.layer = ObstacleLayer;
                    Mesh volume = TrianglePrism(a - center, b - center, c - center,
                        Mathf.Min(region.BedHeight - 1, terrain.transform.position.y - .25f), region.WaterHeight + .8f);
                    SaveMesh(volume, folder, "WaterVolume" + id);
                    var collider = obstacle.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = volume;
                    collider.convex = true;
                }
            }
        }

        private static void PopulateGroundDetails(Terrain terrain, GroundRecipe recipe, PrototypeArtSet art,
            TreePalette palette, GroundPathMath paths, Transform parent, System.Random random)
        {
            Transform root = Group("Forest floor and shoreline stones", parent);
            var candidates = new List<Vector2>();
            foreach (GroundWaterRegion region in recipe.WaterRegions)
            for (int i = 0; i < region.Points.Count; i++)
            {
                Vector2 a = region.Points[i], b = region.Points[(i + 1) % region.Points.Count];
                int steps = Mathf.CeilToInt(Vector2.Distance(a, b) / 3.5f);
                for (int step = 0; step < steps; step++)
                {
                    Vector2 edge = Vector2.Lerp(a, b, (step + .5f) / Mathf.Max(1, steps));
                    Vector2 normal = new Vector2(b.y - a.y, a.x - b.x).normalized;
                    foreach (float side in new[] { -1f, 1f })
                    {
                        Vector2 point = edge + normal * (2 + Next(random, 0, 1)) * side;
                        Vector2 map = ExpandedForestDefinition.ToMapXZ(point);
                        if (!ExpandedForestDefinition.PlayableMapBounds.Contains(map) ||
                            ExpandedForestDefinition.InClearing(point, 1) || paths.IsWater(point, .65f) ||
                            TouchesTrail(paths, point, 1.2f)) continue;
                        if (GroundPoint(terrain, point).y > ExpandedForestDefinition.WaterHeight + .18f)
                            candidates.Add(point);
                    }
                }
            }
            Shuffle(candidates, random);
            for (int i = 0; i < Mathf.Min(68, candidates.Count); i++)
            {
                var rock = (GameObject)PrefabUtility.InstantiatePrefab(art.Rock, root);
                rock.name = "Shore stone " + (i + 1).ToString("00");
                rock.transform.position = GroundPoint(terrain, candidates[i]);
                rock.transform.rotation = Quaternion.Euler(0, Next(random, 0, 360), 0);
                rock.transform.localScale = new Vector3(Next(random, 1.2f, 2.5f), Next(random, .8f, 1.3f), Next(random, 1, 1.8f));
            }

            Transform shrubs = Group("Low shrubs along forest edges", root);
            Rect bounds = ExpandedForestDefinition.PlayableMapBounds;
            int bushes = 0;
            for (int attempt = 0; attempt < 9000 && bushes < 110; attempt++)
            {
                Vector2 point = ExpandedForestDefinition.ToWorldXZ(new Vector2(
                    Next(random, bounds.xMin, bounds.xMax), Next(random, bounds.yMin, bounds.yMax)));
                if (ExpandedForestDefinition.InClearing(point, .6f) || paths.IsWater(point, 1.6f) ||
                    TouchesTrail(paths, point, .85f)) continue;
                if (!ExpandedForestDefinition.InClearing(point, 4f) && !TouchesTrail(paths, point, 5f)) continue;
                Transform bush = Group("Forest shrub " + (++bushes).ToString("000"), shrubs);
                bush.position = GroundPoint(terrain, point);
                bush.rotation = Quaternion.Euler(0, Next(random, 0, 360), 0);
                float scale = Next(random, .8f, 1.25f);
                for (int lobe = 0; lobe < 2; lobe++)
                {
                    Transform leaves = Group("Leaf mass", bush);
                    leaves.localPosition = new Vector3((lobe - .5f) * .38f, .3f + lobe * .13f, 0) * scale;
                    leaves.localScale = new Vector3(.49f, .36f + lobe * .1f, .4f) * scale;
                    leaves.gameObject.AddComponent<MeshFilter>().sharedMesh = palette.Parts[1];
                    var renderer = leaves.gameObject.AddComponent<MeshRenderer>();
                    renderer.sharedMaterial = palette.Materials[palette.MaterialIndices[lobe + 1]];
                    renderer.shadowCastingMode = ShadowCastingMode.Off;
                }
            }
        }

        internal static List<Vector2> CleanPolygon(IReadOnlyList<Vector2> source)
        {
            var result = new List<Vector2>();
            for (int i = 0; i < source.Count; i++)
                if (result.Count == 0 || (source[i] - result[result.Count - 1]).sqrMagnitude > .000001f)
                    result.Add(source[i]);
            if (result.Count > 1 && (result[0] - result[result.Count - 1]).sqrMagnitude < .000001f)
                result.RemoveAt(result.Count - 1);
            // Collinear border points prevent stable ear clipping and add no shoreline detail.
            bool changed = true;
            while (changed && result.Count > 3)
            {
                changed = false;
                for (int i = 0; i < result.Count; i++)
                {
                    Vector2 a = result[(i + result.Count - 1) % result.Count];
                    Vector2 b = result[i], c = result[(i + 1) % result.Count];
                    if (Mathf.Abs(Cross(b - a, c - b)) > .00001f) continue;
                    result.RemoveAt(i);
                    changed = true;
                    break;
                }
            }
            float area = 0;
            for (int i = 0; i < result.Count; i++) area += Cross(result[i], result[(i + 1) % result.Count]);
            if (area < 0) result.Reverse();
            if (result.Count < 3 || Mathf.Abs(area) < .001f)
                throw new InvalidOperationException("Coastal water polygon has no usable area.");
            return result;
        }

        internal static List<int> Triangulate(List<Vector2> points)
        {
            var remaining = new List<int>();
            var result = new List<int>();
            for (int i = 0; i < points.Count; i++) remaining.Add(i);
            while (remaining.Count > 3)
            {
                bool clipped = false;
                for (int i = 0; i < remaining.Count; i++)
                {
                    int a = remaining[(i + remaining.Count - 1) % remaining.Count];
                    int b = remaining[i], c = remaining[(i + 1) % remaining.Count];
                    if (Cross(points[b] - points[a], points[c] - points[b]) <= .00001f) continue;
                    bool contains = false;
                    foreach (int other in remaining)
                    {
                        if (other == a || other == b || other == c) continue;
                        Vector2 p = points[other];
                        if (Cross(points[b] - points[a], p - points[a]) >= -.00001f &&
                            Cross(points[c] - points[b], p - points[b]) >= -.00001f &&
                            Cross(points[a] - points[c], p - points[c]) >= -.00001f)
                        { contains = true; break; }
                    }
                    if (contains) continue;
                    result.AddRange(new[] { a, b, c });
                    remaining.RemoveAt(i);
                    clipped = true;
                    break;
                }
                if (!clipped) throw new InvalidOperationException("Coastal polygon intersects itself or cannot be triangulated.");
            }
            result.AddRange(remaining);
            return result;
        }

        internal static Mesh TrianglePrism(Vector2 a, Vector2 b, Vector2 c, float bottom, float top)
        {
            var mesh = new Mesh
            {
                name = "Convex coastal obstacle",
                vertices = new[] { new Vector3(a.x, bottom, a.y), new Vector3(b.x, bottom, b.y),
                    new Vector3(c.x, bottom, c.y), new Vector3(a.x, top, a.y),
                    new Vector3(b.x, top, b.y), new Vector3(c.x, top, c.y) },
                triangles = new[] { 0, 1, 2, 3, 5, 4, 0, 3, 1, 1, 3, 4,
                    1, 4, 2, 2, 4, 5, 2, 5, 0, 0, 5, 3 }
            };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }

        internal static void SaveMesh(Mesh mesh, string folder, string name)
        {
            AssetDatabase.CreateAsset(mesh, AssetDatabase.GenerateUniqueAssetPath(folder + "/" + name + ".asset"));
        }

        private static Transform Group(string name, Transform parent)
        {
            Transform group = new GameObject(name).transform;
            group.SetParent(parent, false);
            return group;
        }

        private static Vector3 GroundPoint(Terrain terrain, Vector2 point)
        {
            var result = new Vector3(point.x, 0, point.y);
            result.y = terrain.SampleHeight(result) + terrain.transform.position.y;
            return result;
        }

        private static void Shuffle<T>(List<T> values, System.Random random)
        {
            for (int i = values.Count - 1; i > 0; i--)
            {
                int j = random.Next(i + 1);
                T value = values[i]; values[i] = values[j]; values[j] = value;
            }
        }

        private static float Cross(Vector2 a, Vector2 b) => a.x * b.y - a.y * b.x;
        private static float Next(System.Random random, float min, float max) => min + (float)random.NextDouble() * (max - min);

        private sealed class TreePlacement
        {
            public Vector3 Position;
            public Quaternion Rotation;
            public Vector3 Scale;
            public bool NearTrail;
            public bool HasCollider;
        }

        private sealed class TreePalette
        {
            public readonly Material[] Materials;
            public readonly Mesh[] Parts;
            public readonly int[] MaterialIndices;
            public readonly Matrix4x4[] Transforms;

            public TreePalette(GameObject tree, string folder)
            {
                // The background keeps the silhouette/palette, but not the near prefab's flat
                // per-face vertices or tiny branches. This prevents multi-million-vertex assets.
                Mesh crown = CreateCrownMesh();
                Mesh trunk = CreateTrunkMesh();
                SaveMesh(crown, folder, "DeepForestCrown");
                SaveMesh(trunk, folder, "DeepForestTrunk");
                string[] names = { "Tapered trunk", "Lower foliage", "Sunward foliage", "Crown" };
                Parts = new[] { trunk, crown, crown, crown };
                MaterialIndices = new int[names.Length];
                Transforms = new Matrix4x4[names.Length];
                var materials = new List<Material>();
                for (int i = 0; i < names.Length; i++)
                {
                    Transform source = tree.transform.Find(names[i]);
                    if (source == null) throw new InvalidOperationException("Forest tree prefab lacks " + names[i]);
                    Material material = source.GetComponent<MeshRenderer>().sharedMaterial;
                    int index = materials.IndexOf(material);
                    if (index < 0) { index = materials.Count; materials.Add(material); }
                    MaterialIndices[i] = index;
                    Transforms[i] = tree.transform.worldToLocalMatrix * source.localToWorldMatrix;
                }
                Materials = materials.ToArray();
            }

            private static Mesh CreateCrownMesh()
            {
                float t = (1 + Mathf.Sqrt(5)) * .5f;
                var vertices = new[]
                {
                    new Vector3(-1,t,0), new Vector3(1,t,0), new Vector3(-1,-t,0), new Vector3(1,-t,0),
                    new Vector3(0,-1,t), new Vector3(0,1,t), new Vector3(0,-1,-t), new Vector3(0,1,-t),
                    new Vector3(t,0,-1), new Vector3(t,0,1), new Vector3(-t,0,-1), new Vector3(-t,0,1)
                };
                for (int i = 0; i < vertices.Length; i++) vertices[i].Normalize();
                var mesh = new Mesh
                {
                    name = "Deep forest canopy - 20 triangles",
                    vertices = vertices,
                    triangles = new[] { 0,11,5, 0,5,1, 0,1,7, 0,7,10, 0,10,11,
                        1,5,9, 5,11,4, 11,10,2, 10,7,6, 7,1,8, 3,9,4, 3,4,2,
                        3,2,6, 3,6,8, 3,8,9, 4,9,5, 2,4,11, 6,2,10, 8,6,7, 9,8,1 }
                };
                mesh.RecalculateNormals();
                mesh.RecalculateBounds();
                return mesh;
            }

            private static Mesh CreateTrunkMesh()
            {
                const int sides = 6;
                var vertices = new Vector3[sides * 2 + 2];
                var triangles = new List<int>();
                vertices[sides * 2 + 1] = Vector3.up;
                for (int i = 0; i < sides; i++)
                {
                    float angle = i * Mathf.PI * 2 / sides;
                    vertices[i] = new Vector3(Mathf.Cos(angle), 0, Mathf.Sin(angle));
                    vertices[sides + i] = new Vector3(Mathf.Cos(angle) * .8f, 1, Mathf.Sin(angle) * .8f);
                    int next = (i + 1) % sides;
                    triangles.AddRange(new[] { i, sides + i, next, next, sides + i, sides + next,
                        sides * 2, i, next, sides * 2 + 1, sides + next, sides + i });
                }
                var mesh = new Mesh { name = "Deep forest trunk", vertices = vertices, triangles = triangles.ToArray() };
                mesh.RecalculateNormals();
                mesh.RecalculateBounds();
                return mesh;
            }
        }

        private sealed class ForestPatch
        {
            private readonly Transform root;
            private readonly List<CombineInstance>[] parts;
            private readonly Vector2Int key;
            private int treeCount;

            public ForestPatch(Vector2Int key, Transform parent, int materials)
            {
                this.key = key;
                root = Group("Forest patch " + key.x + ", " + key.y, parent);
                root.position = new Vector3((key.x + .5f) * PatchSize, 0, (key.y + .5f) * PatchSize);
                parts = new List<CombineInstance>[materials];
                for (int i = 0; i < materials; i++) parts[i] = new List<CombineInstance>();
            }

            public void AddTree(TreePlacement tree, TreePalette palette)
            {
                treeCount++;
                Matrix4x4 treeTransform = root.worldToLocalMatrix * Matrix4x4.TRS(tree.Position, tree.Rotation, tree.Scale);
                for (int i = 0; i < palette.Parts.Length; i++)
                    parts[palette.MaterialIndices[i]].Add(new CombineInstance
                    { mesh = palette.Parts[i], transform = treeTransform * palette.Transforms[i] });
                if (!tree.HasCollider) return;
                Transform trunk = Group("Trunk obstacle " + treeCount.ToString("00"), root);
                trunk.SetPositionAndRotation(tree.Position, tree.Rotation);
                trunk.localScale = tree.Scale;
                trunk.gameObject.layer = ObstacleLayer;
                var collider = trunk.gameObject.AddComponent<BoxCollider>();
                collider.center = new Vector3(0, 1.3f, 0);
                collider.size = new Vector3(.58f, 2.6f, .58f);
            }

            public void SaveMesh(string folder, Material[] materials)
            {
                var combined = new List<CombineInstance>();
                var temporary = new List<Mesh>();
                try
                {
                    foreach (List<CombineInstance> materialParts in parts)
                    {
                        var mesh = new Mesh { indexFormat = IndexFormat.UInt32 };
                        mesh.CombineMeshes(materialParts.ToArray(), true, true);
                        temporary.Add(mesh);
                        combined.Add(new CombineInstance { mesh = mesh, transform = Matrix4x4.identity });
                    }
                    var result = new Mesh { name = "Forest patch " + key.x + ", " + key.y, indexFormat = IndexFormat.UInt32 };
                    result.CombineMeshes(combined.ToArray(), false, false);
                    result.RecalculateBounds();
                    ExpandedForestEnvironment.SaveMesh(result, folder, "ForestPatch_" + key.x + "_" + key.y);
                    root.gameObject.AddComponent<MeshFilter>().sharedMesh = result;
                    MeshRenderer renderer = root.gameObject.AddComponent<MeshRenderer>();
                    renderer.sharedMaterials = materials;
                    renderer.shadowCastingMode = ShadowCastingMode.On;
                    renderer.lightProbeUsage = LightProbeUsage.Off;
                    renderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
                    root.name += " (" + treeCount + " trees)";
                }
                finally { foreach (Mesh mesh in temporary) Object.DestroyImmediate(mesh); }
            }
        }
    }
}
