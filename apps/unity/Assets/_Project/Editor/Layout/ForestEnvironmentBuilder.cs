using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    public sealed class ForestEnvironmentResult
    {
        public Transform Root;
        public Transform Lake;
        public Transform Ruins;
        public Transform Camp;
        public Transform Market;
        public Transform Lookout;
        public int TreeCount;
    }

    /// <summary>One-time Editor population. Every result is an ordinary editable scene object.</summary>
    public static class ForestEnvironmentBuilder
    {
        private const int ObstacleLayer = 9;
        private const int TreeTarget = 175;

        public static ForestEnvironmentResult Build(Terrain terrain, Zhiv.WorldPrototype.GroundRecipe recipe,
            PrototypeArtSet art, Transform parent, string assetFolder)
        {
            if (terrain == null || terrain.terrainData == null || art == null || art.Tree == null ||
                art.Rock == null || art.Home == null || art.Water == null)
                throw new ArgumentException("Forest population needs a baked Terrain and tree/rock prefabs.");
            if (!AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for persistent water meshes first.", nameof(assetFolder));
            var root = Group("Forest Environment", parent);
            var result = new ForestEnvironmentResult { Root = root };
            var palette = new SharedPalette(art);
            var random = new System.Random(recipe.Seed + 204);
            var sampler = new GroundPathMath(recipe);
            var occupied = new List<Vector3>();

            Transform woods = Group("Forest masses - editable prefab instances", root);
            var clusters = new[]
            {
                new ForestMass("North west canopy", new Vector2(-16, 21), new Vector2(9, 8), woods),
                new ForestMass("Northern ridge", new Vector2(5, 24), new Vector2(17, 5), woods),
                new ForestMass("North east woods", new Vector2(14, 13), new Vector2(10, 12), woods),
                new ForestMass("Western woods", new Vector2(-19, -3), new Vector2(6, 19), woods),
                new ForestMass("Central thicket", new Vector2(-5, -3), new Vector2(5, 8), woods),
                new ForestMass("Eastern bank woods", new Vector2(21, -9), new Vector2(3.5f, 18), woods),
                new ForestMass("Southern edge", new Vector2(-4, -25), new Vector2(18, 4), woods),
                new ForestMass("Home eastern edge", new Vector2(9, 3), new Vector2(6, 5), woods)
            };
            for (int attempt = 0; attempt < 12000 && result.TreeCount < TreeTarget; attempt++)
            {
                Vector2 p = new Vector2(Next(random, -22.3f, 22.3f), Next(random, -26.3f, 26.3f));
                ForestMass mass = ClosestMass(clusters, p);
                if (mass == null) continue;
                float scale = Next(random, .76f, 1.18f);
                float crownRadius = 1.3f * scale;
                if (!CanPlace(p, crownRadius, terrain, sampler, occupied, .7f)) continue;
                GameObject tree = Prefab(art.Tree, mass.Parent, p, terrain, scale, random);
                tree.name = "Tree " + (++result.TreeCount).ToString("000");
                occupied.Add(new Vector3(p.x, crownRadius, p.y));
            }

            Transform undergrowth = Group("Undergrowth and stones", root);
            int bushes = 0;
            int rocks = 0;
            for (int attempt = 0; attempt < 2400 && (bushes < 80 || rocks < 38); attempt++)
            {
                Vector2 p = new Vector2(Next(random, -22, 22), Next(random, -26, 26));
                if (ClosestMass(clusters, p) == null) continue;
                bool makeRock = rocks < 38 && (bushes >= 80 || random.NextDouble() < .3);
                float radius = makeRock ? .65f : .5f;
                if (!CanPlace(p, radius, terrain, sampler, occupied, -.15f)) continue;
                if (makeRock)
                {
                    GameObject rock = Prefab(art.Rock, undergrowth, p, terrain, Next(random, .65f, 1.25f), random);
                    rock.name = "Forest stone " + (++rocks).ToString("00");
                }
                else
                {
                    Transform bush = Group("Bush " + (++bushes).ToString("00"), undergrowth);
                    bush.position = GroundPoint(terrain, p);
                    for (int lobe = 0; lobe < 3; lobe++)
                        MeshPart(bush, "Leaf cluster", palette.Foliage, palette.Leaves[lobe % palette.Leaves.Length],
                            new Vector3((lobe - 1) * .27f, .22f + lobe % 2 * .11f, Next(random, -.14f, .14f)),
                            new Vector3(.38f, .26f + lobe % 2 * .1f, .34f));
                }
                occupied.Add(new Vector3(p.x, radius * .65f, p.y));
            }

            result.Lake = CreateLake(terrain, art.Water, root, assetFolder);
            AddBankStones(terrain, art.Rock, result.Lake, sampler, random);
            result.Ruins = CreateRuins(terrain, root, palette);
            result.Camp = CreateCamp(terrain, root, palette);
            result.Market = CreateMarket(terrain, root, palette);
            result.Lookout = CreateLookout(terrain, root, palette);
            return result;
        }

        private static bool CanPlace(Vector2 point, float radius, Terrain terrain, GroundPathMath paths,
            List<Vector3> occupied, float clearingMargin)
        {
            if (ForestLayoutRecipe.InLakeReserve(point, radius + .3f) ||
                ForestLayoutRecipe.InClearing(point, radius + clearingMargin)) return false;
            // Reserve the crown as well as the trunk so the fixed camera still sees the trail.
            if (paths.SamplePathWeight(point) > .015f) return false;
            for (int side = 0; side < 12; side++)
            {
                float angle = side * Mathf.PI * 2 / 12;
                Vector2 edge = point + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * (radius + .25f);
                if (paths.SamplePathWeight(edge) > .015f) return false;
            }
            Vector3 ground = GroundPoint(terrain, point);
            if (ground.y < -.12f) return false;
            foreach (Vector3 other in occupied)
            {
                float clearance = (radius + other.y) * .83f;
                if ((point - new Vector2(other.x, other.z)).sqrMagnitude < clearance * clearance) return false;
            }
            return true;
        }

        private static Transform CreateLake(Terrain terrain, Material material, Transform parent, string folder)
        {
            const int sides = 32;
            Vector2 center = ForestLayoutRecipe.LakeCenter;
            var outline = new Vector2[sides];
            for (int i = 0; i < sides; i++)
            {
                float angle = i * Mathf.PI * 2 / sides;
                Vector2 ray = new Vector2(Mathf.Cos(angle) * ForestLayoutRecipe.LakeRadii.x,
                    Mathf.Sin(angle) * ForestLayoutRecipe.LakeRadii.y);
                float low = 0, high = 1;
                // Find the baked contour, with the final vertex slightly under the bank.
                for (int iteration = 0; iteration < 15; iteration++)
                {
                    float mid = (low + high) * .5f;
                    if (GroundPoint(terrain, center + ray * mid).y < ForestLayoutRecipe.WaterHeight) low = mid;
                    else high = mid;
                }
                outline[i] = ray * Mathf.Min(1f, high + .008f);
            }

            var water = Group("Lake - fitted shoreline", parent);
            water.position = new Vector3(center.x, ForestLayoutRecipe.WaterHeight, center.y);
            Mesh visible = WaterMesh(outline);
            AssetDatabase.CreateAsset(visible, AssetDatabase.GenerateUniqueAssetPath(folder + "/LakeSurface.asset"));
            var filter = water.gameObject.AddComponent<MeshFilter>();
            filter.sharedMesh = visible;
            var renderer = water.gameObject.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;

            // A closed convex volume catches capsule overlap above the submerged Terrain.
            // A surface-only collider would allow the character to walk along the lake bed.
            var obstacle = Group("Water navigation obstacle", water);
            obstacle.gameObject.layer = ObstacleLayer;
            Mesh volume = WaterVolume(outline, -1.2f - ForestLayoutRecipe.WaterHeight,
                1.2f - ForestLayoutRecipe.WaterHeight);
            AssetDatabase.CreateAsset(volume, AssetDatabase.GenerateUniqueAssetPath(folder + "/LakeObstacle.asset"));
            var collider = obstacle.gameObject.AddComponent<MeshCollider>();
            collider.sharedMesh = volume;
            collider.convex = true;
            return water;
        }

        private static Mesh WaterMesh(Vector2[] outline)
        {
            int count = outline.Length;
            var vertices = new Vector3[count + 1];
            var uv = new Vector2[count + 1];
            var triangles = new int[count * 3];
            uv[0] = Vector2.one * .5f;
            for (int i = 0; i < count; i++)
            {
                vertices[i + 1] = new Vector3(outline[i].x, 0, outline[i].y);
                uv[i + 1] = new Vector2(outline[i].x / 12 + .5f, outline[i].y / 16 + .5f);
                triangles[i * 3] = 0;
                triangles[i * 3 + 1] = (i + 1) % count + 1;
                triangles[i * 3 + 2] = i + 1;
            }
            var mesh = new Mesh { name = "Lake surface", vertices = vertices, uv = uv, triangles = triangles };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }

        private static Mesh WaterVolume(Vector2[] outline, float bottom, float top)
        {
            int count = outline.Length;
            var vertices = new Vector3[count * 2];
            var triangles = new List<int>();
            for (int i = 0; i < count; i++)
            {
                vertices[i] = new Vector3(outline[i].x, bottom, outline[i].y);
                vertices[count + i] = new Vector3(outline[i].x, top, outline[i].y);
                int next = (i + 1) % count;
                triangles.AddRange(new[] { i, count + i, next, next, count + i, count + next });
            }
            for (int i = 1; i < count - 1; i++)
            {
                triangles.AddRange(new[] { 0, i, i + 1 });
                triangles.AddRange(new[] { count, count + i + 1, count + i });
            }
            var mesh = new Mesh { name = "Closed lake obstacle", vertices = vertices, triangles = triangles.ToArray() };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }

        private static void AddBankStones(Terrain terrain, GameObject prefab, Transform lake,
            GroundPathMath paths, System.Random random)
        {
            Transform group = Group("Bank stones", lake);
            for (int i = 0; i < 26; i++)
            {
                float angle = i * Mathf.PI * 2 / 26;
                Vector2 p = ForestLayoutRecipe.LakeCenter + new Vector2(Mathf.Cos(angle) * 6.2f,
                    Mathf.Sin(angle) * 8.1f);
                if (paths.SamplePathWeight(p) > .01f || ForestLayoutRecipe.InClearing(p, .5f)) continue;
                Prefab(prefab, group, p, terrain, Next(random, .6f, 1.3f), random).name = "Bank stone";
            }
        }

        private static Transform CreateRuins(Terrain terrain, Transform parent, SharedPalette p)
        {
            Transform root = Landmark("Ruins - placeholder footprint", ForestLayoutRecipe.Ruins, terrain, parent);
            for (int i = 0; i < 5; i++)
            {
                float height = i == 2 ? 1.25f : .55f + (i % 3) * .3f;
                Primitive(root, "Broken back wall", PrimitiveType.Cube, p.Stone,
                    new Vector3(-1.8f + i * .9f, height * .5f, 1.1f), new Vector3(.8f, height, .65f), true);
            }
            foreach (float x in new[] { -2f, 2f })
                Primitive(root, "Gate remnant", PrimitiveType.Cube, p.Stone,
                    new Vector3(x, .8f, -.3f), new Vector3(.7f, 1.6f, .85f), true);
            return root;
        }

        private static Transform CreateCamp(Terrain terrain, Transform parent, SharedPalette p)
        {
            Transform root = Landmark("Camp - gathering space", ForestLayoutRecipe.Camp, terrain, parent);
            // The entrance marker is at the centre; put the fire aside so that point remains walkable.
            Transform fire = Group("Cold firepit", root);
            fire.localPosition = new Vector3(1.65f, 0, .85f);
            for (int i = 0; i < 8; i++)
            {
                float angle = i * Mathf.PI * 2 / 8;
                MeshPart(fire, "Fire ring stone", p.Foliage, p.Stone,
                    new Vector3(Mathf.Cos(angle) * .48f, .1f, Mathf.Sin(angle) * .48f),
                    new Vector3(.23f, .15f, .2f));
            }
            Primitive(fire, "Ash", PrimitiveType.Cylinder, p.Dark,
                new Vector3(0, .025f, 0), new Vector3(.75f, .025f, .75f), false);
            Primitive(root, "Seating log", PrimitiveType.Cube, p.Wood,
                new Vector3(1.8f, .22f, 1.6f), new Vector3(1.7f, .44f, .42f), true);
            return root;
        }

        private static Transform CreateMarket(Terrain terrain, Transform parent, SharedPalette p)
        {
            Transform root = Landmark("Market - future stall footprint", ForestLayoutRecipe.Market, terrain, parent);
            Primitive(root, "Counter", PrimitiveType.Cube, p.Wood,
                new Vector3(0, .9f, 0), new Vector3(3.2f, .2f, 1.15f), false);
            foreach (float x in new[] { -1.25f, 1.25f })
            foreach (float z in new[] { -.35f, .35f })
                Primitive(root, "Table leg", PrimitiveType.Cube, p.Wood,
                    new Vector3(x, .4f, z), new Vector3(.18f, .8f, .18f), false);
            var collider = root.gameObject.AddComponent<BoxCollider>();
            collider.center = new Vector3(0, .5f, 0);
            collider.size = new Vector3(3.3f, 1, 1.3f);
            root.gameObject.layer = ObstacleLayer;
            return root;
        }

        private static Transform CreateLookout(Terrain terrain, Transform parent, SharedPalette p)
        {
            Transform root = Landmark("Lookout - future landmark footprint", ForestLayoutRecipe.Lookout, terrain, parent);
            // Keep the arrival point clear, place the recognizable survey post on the rear edge.
            Primitive(root, "Survey post", PrimitiveType.Cylinder, p.Wood,
                new Vector3(0, 1.05f, 1.7f), new Vector3(.25f, 1.05f, .25f), true);
            Primitive(root, "Landmark sign", PrimitiveType.Cube, p.Wood,
                new Vector3(0, 1.85f, 1.7f), new Vector3(1.1f, .4f, .12f), false);
            return root;
        }

        private static Transform Landmark(string name, ForestZoneDefinition zone, Terrain terrain, Transform parent)
        {
            Transform result = Group(name, parent);
            result.position = GroundPoint(terrain, zone.Center);
            return result;
        }

        private static Transform Group(string name, Transform parent)
        {
            var result = new GameObject(name).transform;
            result.SetParent(parent, false);
            return result;
        }

        private static GameObject Prefab(GameObject prefab, Transform parent, Vector2 point, Terrain terrain,
            float scale, System.Random random)
        {
            var result = (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent);
            result.transform.position = GroundPoint(terrain, point);
            result.transform.rotation = Quaternion.Euler(0, Next(random, 0, 360), 0);
            result.transform.localScale = Vector3.one * scale;
            return result;
        }

        private static void MeshPart(Transform parent, string name, Mesh mesh, Material material,
            Vector3 position, Vector3 scale)
        {
            Transform part = Group(name, parent);
            part.localPosition = position;
            part.localScale = scale;
            part.gameObject.AddComponent<MeshFilter>().sharedMesh = mesh;
            part.gameObject.AddComponent<MeshRenderer>().sharedMaterial = material;
        }

        private static void Primitive(Transform parent, string name, PrimitiveType type, Material material,
            Vector3 position, Vector3 scale, bool obstacle)
        {
            var part = GameObject.CreatePrimitive(type);
            part.name = name;
            part.transform.SetParent(parent, false);
            part.transform.localPosition = position;
            part.transform.localScale = scale;
            part.GetComponent<Renderer>().sharedMaterial = material;
            if (obstacle) part.layer = ObstacleLayer;
            else Object.DestroyImmediate(part.GetComponent<Collider>());
        }

        private static Vector3 GroundPoint(Terrain terrain, Vector2 point)
        {
            var position = new Vector3(point.x, 0, point.y);
            position.y = terrain.SampleHeight(position) + terrain.transform.position.y;
            return position;
        }

        private static float Next(System.Random random, float min, float max)
        {
            return min + (float)random.NextDouble() * (max - min);
        }

        private static ForestMass ClosestMass(ForestMass[] masses, Vector2 point)
        {
            ForestMass best = null;
            float bestDistance = 1;
            foreach (ForestMass mass in masses)
            {
                Vector2 delta = point - mass.Center;
                float distance = delta.x * delta.x / (mass.Radii.x * mass.Radii.x)
                    + delta.y * delta.y / (mass.Radii.y * mass.Radii.y);
                if (distance >= bestDistance) continue;
                bestDistance = distance;
                best = mass;
            }
            return best;
        }

        private sealed class ForestMass
        {
            public readonly Vector2 Center;
            public readonly Vector2 Radii;
            public readonly Transform Parent;
            public ForestMass(string name, Vector2 center, Vector2 radii, Transform parent)
            {
                Center = center;
                Radii = radii;
                Parent = Group(name, parent);
            }
        }

        private sealed class SharedPalette
        {
            public readonly Mesh Foliage;
            public readonly Material[] Leaves;
            public readonly Material Wood;
            public readonly Material Stone;
            public readonly Material Dark;
            public SharedPalette(PrototypeArtSet art)
            {
                // Reuse the original persistent assets; no per-instance Material copies.
                Transform leaf = art.Tree.transform.Find("Lower foliage");
                Foliage = leaf.GetComponent<MeshFilter>().sharedMesh;
                Leaves = new[]
                {
                    leaf.GetComponent<Renderer>().sharedMaterial,
                    art.Tree.transform.Find("Sunward foliage").GetComponent<Renderer>().sharedMaterial,
                    art.Tree.transform.Find("Crown").GetComponent<Renderer>().sharedMaterial
                };
                Wood = art.Tree.transform.Find("Tapered trunk").GetComponent<Renderer>().sharedMaterial;
                Stone = art.Rock.transform.Find("Faceted rock").GetComponent<Renderer>().sharedMaterial;
                Dark = art.Home.transform.Find("Entrance shadow").GetComponent<Renderer>().sharedMaterial;
            }
        }
    }
}
