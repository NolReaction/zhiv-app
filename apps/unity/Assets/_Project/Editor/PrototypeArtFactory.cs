using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Persistent, editable starter art. Every dimension is in metres.</summary>
    public sealed class PrototypeArtSet
    {
        public GameObject Workshop;
        public GameObject Home;
        public GameObject Tree;
        public GameObject Rock;
        public GameObject Actor;
        public Material Grass;
        public Material Path;
        public Material Water;
    }

    /// <summary>
    /// Creates original geometry, materials and prefabs once in a new asset folder.
    /// Building doors face -Z, the actor faces +Z, all pivots sit on the ground.
    /// This is an editor authoring tool; the player only loads the saved assets.
    /// </summary>
    public static class PrototypeArtFactory
    {
        private const int ObstacleLayer = 9;

        public static PrototypeArtSet Create(string assetFolder)
        {
            if (string.IsNullOrEmpty(assetFolder) || !assetFolder.StartsWith("Assets/", StringComparison.Ordinal)
                || assetFolder.Contains("..") || assetFolder.Contains("\\"))
                throw new ArgumentException("Use a new folder beneath Assets/.", nameof(assetFolder));

            string folder = assetFolder.TrimEnd('/');
            EnsureFolder(folder);
            // Never overwrite an authored material, prefab or mesh on a repeated invocation.
            if (AssetDatabase.FindAssets("", new[] { folder }).Length != 0)
                throw new InvalidOperationException("Art folder must be empty. Existing assets are preserved: " + folder);

            Shader shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null)
                throw new InvalidOperationException("URP/Lit is unavailable. Allow Unity to finish installing URP first.");

            var palette = new Palette(folder, shader);
            Mesh foliage = SaveMesh(CreateFacetedSphere(), folder + "/Foliage.asset");
            Mesh trunk = SaveMesh(CreateTrunk(), folder + "/Trunk.asset");
            Mesh roof = SaveMesh(CreateRoof(), folder + "/Roof.asset");

            var result = new PrototypeArtSet
            {
                Grass = palette.Grass,
                Path = palette.Path,
                Water = palette.Water,
                Workshop = SavePrefab(CreateWorkshop(palette, foliage, roof), folder + "/Workshop.prefab"),
                Home = SavePrefab(CreateHome(palette, foliage, trunk), folder + "/Home.prefab"),
                Tree = SavePrefab(CreateTree(palette, foliage, trunk), folder + "/Tree.prefab"),
                Rock = SavePrefab(CreateRock(palette, foliage), folder + "/Rock.prefab"),
                Actor = SavePrefab(CreateActor(palette), folder + "/MochlikProxy.prefab")
            };
            AssetDatabase.SaveAssets();
            return result;
        }

        private static GameObject CreateWorkshop(Palette p, Mesh foliage, Mesh roof)
        {
            var root = new GameObject("Workshop");
            RootObstacle(root, new Vector3(0, 1.5f, -0.12f), new Vector3(3.65f, 3, 3.8f));
            Part(root, "Stone footing", PrimitiveType.Cube, p.Stone,
                new Vector3(0, 0.13f, 0), new Vector3(3.5f, 0.26f, 3.1f));
            Part(root, "Warm plaster", PrimitiveType.Cube, p.Plaster,
                new Vector3(0, 1.36f, 0), new Vector3(3.12f, 2.2f, 2.72f));

            // Exposed timber framing ties the building to the stump home and workshop furniture.
            foreach (float x in new[] { -1.52f, 1.52f })
            foreach (float z in new[] { -1.33f, 1.33f })
                Part(root, "Corner post", PrimitiveType.Cube, p.Wood,
                    new Vector3(x, 1.39f, z), new Vector3(0.19f, 2.3f, 0.19f));
            foreach (float y in new[] { 0.42f, 2.35f })
                Part(root, "Front beam", PrimitiveType.Cube, p.Wood,
                    new Vector3(0, y, -1.39f), new Vector3(3.25f, 0.15f, 0.16f));

            MeshPart(root, "Gabled moss roof", roof, p.Roof,
                new Vector3(0, 2.42f, 0), new Vector3(3.85f, 1.23f, 3.5f));
            foreach (float z in new[] { -1.79f, 1.79f })
            {
                Beam(root, "Roof fascia", p.WoodLight, new Vector3(-1.98f, 2.4f, z), new Vector3(0, 3.68f, z), 0.15f);
                Beam(root, "Roof fascia", p.WoodLight, new Vector3(0, 3.68f, z), new Vector3(1.98f, 2.4f, z), 0.15f);
            }
            Part(root, "Ridge cap", PrimitiveType.Cube, p.WoodLight,
                new Vector3(0, 3.69f, 0), new Vector3(0.14f, 0.14f, 3.65f));

            Part(root, "Chimney", PrimitiveType.Cube, p.Stone,
                new Vector3(0.99f, 3.2f, 0.54f), new Vector3(0.49f, 1.34f, 0.55f));
            Part(root, "Chimney rim", PrimitiveType.Cube, p.StoneLight,
                new Vector3(0.99f, 3.91f, 0.54f), new Vector3(0.62f, 0.17f, 0.68f));
            Part(root, "Chimney opening", PrimitiveType.Cube, p.Dark,
                new Vector3(0.99f, 4.002f, 0.54f), new Vector3(0.41f, 0.025f, 0.46f));

            Part(root, "Door recess", PrimitiveType.Cube, p.Dark,
                new Vector3(-0.66f, 1.12f, -1.399f), new Vector3(1.03f, 1.74f, 0.09f));
            Part(root, "Door", PrimitiveType.Cube, p.Wood,
                new Vector3(-0.66f, 1.08f, -1.459f), new Vector3(0.81f, 1.56f, 0.07f));
            for (int i = 0; i < 4; i++)
                Part(root, "Door plank", PrimitiveType.Cube, p.WoodLight,
                    new Vector3(-0.94f + i * 0.185f, 1.08f, -1.505f), new Vector3(0.025f, 1.49f, 0.025f));
            Part(root, "Door handle", PrimitiveType.Sphere, p.Copper,
                new Vector3(-0.4f, 1.06f, -1.54f), Vector3.one * 0.095f);
            Part(root, "Doorstep", PrimitiveType.Cube, p.StoneLight,
                new Vector3(-0.66f, 0.12f, -1.74f), new Vector3(1.19f, 0.24f, 0.53f));

            Window(root, p, new Vector3(0.74f, 1.64f, -1.405f), 0.77f);
            var awning = Part(root, "Canopy", PrimitiveType.Cube, p.Copper,
                new Vector3(0.77f, 2.35f, -1.79f), new Vector3(1.6f, 0.1f, 1.01f));
            awning.transform.localRotation = Quaternion.Euler(-12, 0, 0);
            foreach (float x in new[] { 0.07f, 1.47f })
                Part(root, "Canopy post", PrimitiveType.Cube, p.Wood,
                    new Vector3(x, 1.15f, -2.14f), new Vector3(0.105f, 2.3f, 0.105f));
            Part(root, "Work bench", PrimitiveType.Cube, p.WoodLight,
                new Vector3(0.77f, 0.9f, -1.83f), new Vector3(1.36f, 0.15f, 0.55f));
            foreach (float x in new[] { 0.2f, 1.34f })
                Part(root, "Bench leg", PrimitiveType.Cube, p.Wood,
                    new Vector3(x, 0.45f, -1.83f), new Vector3(0.11f, 0.8f, 0.38f));
            Part(root, "Anvil base", PrimitiveType.Cube, p.Iron,
                new Vector3(0.95f, 1.06f, -1.82f), new Vector3(0.29f, 0.24f, 0.25f));
            Part(root, "Anvil face", PrimitiveType.Cube, p.Iron,
                new Vector3(0.95f, 1.22f, -1.82f), new Vector3(0.55f, 0.12f, 0.28f));
            var hammer = new GameObject("HammerPivot");
            hammer.transform.SetParent(root.transform, false);
            hammer.transform.localPosition = new Vector3(0.45f, 1.52f, -1.82f);
            hammer.transform.localRotation = Quaternion.Euler(0, 0, -90);
            Part(hammer, "Handle", PrimitiveType.Cube, p.Wood,
                new Vector3(0, 0.2f, 0), new Vector3(0.06f, 0.43f, 0.065f));
            Part(hammer, "Head", PrimitiveType.Cube, p.Iron,
                new Vector3(0, 0.43f, 0), new Vector3(0.3f, 0.15f, 0.16f));

            for (int i = 0; i < 3; i++)
                MeshPart(root, "Roof moss", foliage, i % 2 == 0 ? p.LeafLight : p.Leaf,
                    new Vector3(-1.48f + i * 0.19f, 2.62f + i * 0.14f, 0.76f), new Vector3(0.43f, 0.14f, 0.52f));
            Lantern(root, p, new Vector3(-1.26f, 1.83f, -1.62f));
            return root;
        }

        private static GameObject CreateHome(Palette p, Mesh foliage, Mesh trunk)
        {
            var root = new GameObject("Stump Home");
            RootObstacle(root, new Vector3(0, 1.5f, 0), new Vector3(3.4f, 3, 3.4f));
            MeshPart(root, "Living stump", trunk, p.Wood, Vector3.zero, new Vector3(1.52f, 2.85f, 1.52f));
            Part(root, "Tree rings top", PrimitiveType.Cylinder, p.WoodLight,
                new Vector3(0, 2.78f, 0), new Vector3(2.33f, 0.06f, 2.33f));
            Part(root, "Tree rings inner", PrimitiveType.Cylinder, p.Wood,
                new Vector3(0, 2.85f, 0), new Vector3(1.72f, 0.012f, 1.72f));
            Part(root, "Tree rings heart", PrimitiveType.Cylinder, p.WoodLight,
                new Vector3(0, 2.868f, 0), new Vector3(1.56f, 0.01f, 1.56f));
            for (int i = 0; i < 9; i++)
            {
                float angle = i * Mathf.PI * 2 / 9;
                Vector3 direction = new Vector3(Mathf.Cos(angle), 0, Mathf.Sin(angle));
                // Leave the front entry clear of roots.
                if (direction.z < -0.75f) continue;
                Beam(root, "Buttress root", p.Wood,
                    direction * 1.17f + Vector3.up * 1.03f,
                    direction * 1.82f + Vector3.up * 0.14f, 0.38f);
                MeshPart(root, "Moss at roots", foliage, p.Leaf,
                    direction * 1.59f + Vector3.up * 0.13f, new Vector3(0.42f, 0.15f, 0.37f));
            }

            Part(root, "Entrance shadow", PrimitiveType.Cube, p.Dark,
                new Vector3(0, 1.09f, -1.5f), new Vector3(1.2f, 1.82f, 0.2f));
            Part(root, "Rounded entrance", PrimitiveType.Sphere, p.Dark,
                new Vector3(0, 1.99f, -1.53f), new Vector3(1.18f, 0.91f, 0.19f));
            Part(root, "Oak door", PrimitiveType.Cube, p.WoodLight,
                new Vector3(0, 1.06f, -1.626f), new Vector3(0.96f, 1.68f, 0.07f));
            Part(root, "Rounded door top", PrimitiveType.Sphere, p.WoodLight,
                new Vector3(0, 1.91f, -1.63f), new Vector3(0.96f, 0.72f, 0.08f));
            foreach (float x in new[] { -0.64f, 0.64f })
                Part(root, "Door jamb", PrimitiveType.Cube, p.WoodLight,
                    new Vector3(x, 1.04f, -1.58f), new Vector3(0.14f, 1.87f, 0.18f));
            for (int i = 0; i < 5; i++)
                Part(root, "Carved door plank", PrimitiveType.Cube, p.Wood,
                    new Vector3(-0.38f + i * 0.19f, 1.09f, -1.674f), new Vector3(0.025f, 1.72f, 0.018f));
            Part(root, "Round door knob", PrimitiveType.Sphere, p.Copper,
                new Vector3(0.32f, 1.1f, -1.73f), Vector3.one * 0.13f);
            Part(root, "Entry stone", PrimitiveType.Cylinder, p.StoneLight,
                new Vector3(0, 0.11f, -1.8f), new Vector3(1.38f, 0.11f, 0.9f));

            for (int i = 0; i < 8; i++)
            {
                float angle = i * Mathf.PI * 2 / 8;
                MeshPart(root, "Moss crown", foliage, i % 2 == 0 ? p.Leaf : p.LeafLight,
                    new Vector3(Mathf.Cos(angle) * 1.05f, 2.96f + i % 3 * 0.05f, Mathf.Sin(angle) * 1.05f),
                    new Vector3(0.64f, 0.26f, 0.51f));
            }
            Beam(root, "Crown twig", p.Wood, new Vector3(0.88f, 2.93f, 0.15f), new Vector3(1.14f, 3.87f, 0.24f), 0.12f);
            var leaf = Part(root, "Growing leaf", PrimitiveType.Sphere, p.LeafLight,
                new Vector3(1.27f, 3.69f, 0.24f), new Vector3(0.49f, 0.16f, 0.24f));
            leaf.transform.localRotation = Quaternion.Euler(0, 0, 38);
            Lantern(root, p, new Vector3(0.97f, 1.89f, -1.36f));
            return root;
        }

        private static GameObject CreateTree(Palette p, Mesh foliage, Mesh trunk)
        {
            var root = new GameObject("Moss Tree");
            RootObstacle(root, new Vector3(0, 1.3f, 0), new Vector3(0.58f, 2.6f, 0.58f));
            MeshPart(root, "Tapered trunk", trunk, p.Wood, Vector3.zero, new Vector3(0.25f, 3.05f, 0.25f));
            Beam(root, "Left branch", p.Wood, new Vector3(0, 1.85f, 0), new Vector3(-0.65f, 2.67f, 0.04f), 0.14f);
            Beam(root, "Right branch", p.Wood, new Vector3(0, 2.2f, 0), new Vector3(0.62f, 3.06f, 0.2f), 0.12f);
            MeshPart(root, "Lower foliage", foliage, p.LeafDark,
                new Vector3(-0.27f, 2.66f, 0), new Vector3(1.02f, 0.74f, 0.91f));
            MeshPart(root, "Sunward foliage", foliage, p.Leaf,
                new Vector3(0.36f, 3.19f, 0.16f), new Vector3(0.91f, 0.79f, 0.82f));
            MeshPart(root, "Crown", foliage, p.LeafLight,
                new Vector3(-0.13f, 3.7f, -0.01f), new Vector3(0.74f, 0.73f, 0.71f));
            return root;
        }

        private static GameObject CreateRock(Palette p, Mesh foliage)
        {
            var root = new GameObject("Moss Rock");
            RootObstacle(root, new Vector3(0, 0.32f, 0), new Vector3(0.95f, 0.65f, 0.9f));
            var body = MeshPart(root, "Faceted rock", foliage, p.Stone,
                new Vector3(0, 0.27f, 0), new Vector3(0.64f, 0.48f, 0.55f));
            body.transform.localRotation = Quaternion.Euler(8, 17, 12);
            MeshPart(root, "Moss cap", foliage, p.Leaf,
                new Vector3(-0.13f, 0.65f, 0.035f), new Vector3(0.39f, 0.08f, 0.3f));
            return root;
        }

        private static GameObject CreateActor(Palette p)
        {
            var root = new GameObject("Mochlik Proxy");
            var visual = new GameObject("Visual");
            visual.transform.SetParent(root.transform, false);
            Part(visual, "Soft moss body", PrimitiveType.Sphere, p.Leaf,
                new Vector3(0, 0.59f, 0), new Vector3(0.62f, 0.82f, 0.52f));
            Part(visual, "Face", PrimitiveType.Sphere, p.Plaster,
                new Vector3(0, 0.68f, 0.2f), new Vector3(0.45f, 0.37f, 0.17f));
            foreach (float side in new[] { -1f, 1f })
            {
                Part(visual, "Eye", PrimitiveType.Sphere, p.Dark,
                    new Vector3(side * 0.095f, 0.725f, 0.282f), new Vector3(0.052f, 0.075f, 0.025f));
                Part(visual, "Eye sparkle", PrimitiveType.Sphere, p.Plaster,
                    new Vector3(side * 0.095f - 0.009f, 0.74f, 0.296f), Vector3.one * 0.015f);
                Part(visual, side < 0 ? "Left foot" : "Right foot", PrimitiveType.Sphere, p.Wood,
                    new Vector3(side * 0.14f, 0.105f, 0.05f), new Vector3(0.23f, 0.2f, 0.33f));
                Part(visual, side < 0 ? "Left arm" : "Right arm", PrimitiveType.Sphere, p.LeafDark,
                    new Vector3(side * 0.32f, 0.57f, 0), new Vector3(0.14f, 0.31f, 0.17f));
            }
            Part(visual, "Smile", PrimitiveType.Sphere, p.Wood,
                new Vector3(0, 0.61f, 0.288f), new Vector3(0.09f, 0.025f, 0.012f));
            Beam(visual, "Sprout stalk", p.LeafDark, new Vector3(0, 0.94f, 0), new Vector3(0.02f, 1.23f, 0), 0.035f);
            var leftLeaf = Part(visual, "Sprout left leaf", PrimitiveType.Sphere, p.LeafLight,
                new Vector3(-0.115f, 1.16f, 0), new Vector3(0.28f, 0.09f, 0.15f));
            leftLeaf.transform.localRotation = Quaternion.Euler(0, 0, -27);
            var rightLeaf = Part(visual, "Sprout right leaf", PrimitiveType.Sphere, p.Leaf,
                new Vector3(0.14f, 1.235f, 0), new Vector3(0.3f, 0.09f, 0.15f));
            rightLeaf.transform.localRotation = Quaternion.Euler(0, 0, 27);
            return root;
        }

        private static void Window(GameObject root, Palette p, Vector3 center, float width)
        {
            Part(root, "Window frame", PrimitiveType.Cube, p.Wood, center, new Vector3(width, width, 0.14f));
            Part(root, "Amber window", PrimitiveType.Cube, p.Glow,
                center + Vector3.back * 0.075f, new Vector3(width * 0.77f, width * 0.77f, 0.025f));
            Part(root, "Window mullion", PrimitiveType.Cube, p.WoodLight,
                center + Vector3.back * 0.102f, new Vector3(0.055f, width * 0.83f, 0.04f));
            Part(root, "Window sill", PrimitiveType.Cube, p.WoodLight,
                center + new Vector3(0, -width * 0.49f, -0.06f), new Vector3(width * 1.16f, 0.09f, 0.26f));
        }

        private static void Lantern(GameObject root, Palette p, Vector3 center)
        {
            Part(root, "Lantern bracket", PrimitiveType.Cube, p.Iron,
                center + new Vector3(0, 0.32f, 0.1f), new Vector3(0.07f, 0.07f, 0.4f));
            Part(root, "Lantern glass", PrimitiveType.Cylinder, p.Glow,
                center, new Vector3(0.19f, 0.13f, 0.19f));
            foreach (float y in new[] { -0.15f, 0.15f })
                Part(root, "Lantern copper cap", PrimitiveType.Cylinder, p.Copper,
                    center + Vector3.up * y, new Vector3(0.26f, 0.025f, 0.26f));
            var lamp = new GameObject("Warm lantern light");
            lamp.transform.SetParent(root.transform, false);
            lamp.transform.localPosition = center + Vector3.back * 0.22f;
            Light light = lamp.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = new Color(1, 0.63f, 0.28f);
            light.range = 3.3f;
            light.intensity = 1.1f;
            light.shadows = LightShadows.None;
        }

        private static void RootObstacle(GameObject root, Vector3 center, Vector3 size)
        {
            root.layer = ObstacleLayer;
            BoxCollider collider = root.AddComponent<BoxCollider>();
            collider.center = center;
            collider.size = size;
        }

        private static GameObject Part(GameObject root, string name, PrimitiveType primitive,
            Material material, Vector3 position, Vector3 scale)
        {
            GameObject part = GameObject.CreatePrimitive(primitive);
            part.name = name;
            Object.DestroyImmediate(part.GetComponent<Collider>());
            Place(root, part, position, scale);
            part.GetComponent<MeshRenderer>().sharedMaterial = material;
            return part;
        }

        private static GameObject MeshPart(GameObject root, string name, Mesh mesh,
            Material material, Vector3 position, Vector3 scale)
        {
            var part = new GameObject(name);
            Place(root, part, position, scale);
            part.AddComponent<MeshFilter>().sharedMesh = mesh;
            part.AddComponent<MeshRenderer>().sharedMaterial = material;
            return part;
        }

        private static void Place(GameObject root, GameObject part, Vector3 position, Vector3 scale)
        {
            part.transform.SetParent(root.transform, false);
            part.transform.localPosition = position;
            part.transform.localScale = scale;
            part.layer = root.layer;
        }

        private static void Beam(GameObject root, string name, Material material, Vector3 from, Vector3 to, float width)
        {
            GameObject beam = Part(root, name, PrimitiveType.Cube, material,
                (from + to) * 0.5f, new Vector3(width, (to - from).magnitude, width));
            beam.transform.localRotation = Quaternion.FromToRotation(Vector3.up, to - from);
        }

        private static GameObject SavePrefab(GameObject root, string path)
        {
            try
            {
                GameObject prefab = PrefabUtility.SaveAsPrefabAsset(root, path);
                if (prefab == null) throw new InvalidOperationException("Could not save prefab: " + path);
                return prefab;
            }
            finally { Object.DestroyImmediate(root); }
        }

        private static Mesh SaveMesh(Mesh mesh, string path)
        {
            AssetDatabase.CreateAsset(mesh, path);
            return mesh;
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            int separator = folder.LastIndexOf('/');
            string parent = folder.Substring(0, separator);
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, folder.Substring(separator + 1));
        }

        private static Mesh CreateRoof()
        {
            // Unit-width/depth gable, ridge at y=1. Flat normals keep planes legible.
            var vertices = new[]
            {
                new Vector3(-0.5f, 0, -0.5f), new Vector3(0.5f, 0, -0.5f), new Vector3(0, 1, -0.5f),
                new Vector3(-0.5f, 0, 0.5f), new Vector3(0.5f, 0, 0.5f), new Vector3(0, 1, 0.5f)
            };
            return FlatMesh("Gable roof", vertices, new[]
            {
                0, 2, 1, 3, 4, 5,
                0, 3, 5, 0, 5, 2,
                1, 2, 5, 1, 5, 4,
                0, 1, 4, 0, 4, 3
            });
        }

        private static Mesh CreateTrunk()
        {
            const int sides = 10;
            float[] heights = { 0, 0.15f, 0.82f, 1 };
            float[] radii = { 1.18f, 1, 0.87f, 0.8f };
            var vertices = new List<Vector3>();
            var triangles = new List<int>();
            for (int ring = 0; ring < heights.Length; ring++)
            for (int side = 0; side < sides; side++)
            {
                float angle = side * Mathf.PI * 2 / sides;
                float radius = radii[ring] * (side % 2 == 0 ? 1 : 0.96f);
                vertices.Add(new Vector3(Mathf.Cos(angle) * radius, heights[ring], Mathf.Sin(angle) * radius));
            }
            for (int ring = 0; ring < heights.Length - 1; ring++)
            for (int side = 0; side < sides; side++)
            {
                int a = ring * sides + side;
                int b = ring * sides + (side + 1) % sides;
                int c = a + sides;
                int d = b + sides;
                triangles.AddRange(new[] { a, c, b, b, c, d });
            }
            for (int i = 1; i < sides - 1; i++)
            {
                triangles.AddRange(new[] { 0, i, i + 1 });
                int top = (heights.Length - 1) * sides;
                triangles.AddRange(new[] { top, top + i + 1, top + i });
            }
            return FlatMesh("Tapered bark", vertices.ToArray(), triangles.ToArray());
        }

        private static Mesh CreateFacetedSphere()
        {
            float t = (1 + Mathf.Sqrt(5)) * 0.5f;
            var vertices = new[]
            {
                new Vector3(-1,t,0), new Vector3(1,t,0), new Vector3(-1,-t,0), new Vector3(1,-t,0),
                new Vector3(0,-1,t), new Vector3(0,1,t), new Vector3(0,-1,-t), new Vector3(0,1,-t),
                new Vector3(t,0,-1), new Vector3(t,0,1), new Vector3(-t,0,-1), new Vector3(-t,0,1)
            };
            int[] faces =
            {
                0,11,5, 0,5,1, 0,1,7, 0,7,10, 0,10,11,
                1,5,9, 5,11,4, 11,10,2, 10,7,6, 7,1,8,
                3,9,4, 3,4,2, 3,2,6, 3,6,8, 3,8,9,
                4,9,5, 2,4,11, 6,2,10, 8,6,7, 9,8,1
            };
            for (int i = 0; i < vertices.Length; i++) vertices[i].Normalize();
            var subdivided = new List<Vector3>();
            var indices = new List<int>();
            for (int i = 0; i < faces.Length; i += 3)
            {
                Vector3 a = vertices[faces[i]], b = vertices[faces[i + 1]], c = vertices[faces[i + 2]];
                Vector3 ab = (a + b).normalized, bc = (b + c).normalized, ca = (c + a).normalized;
                foreach (Vector3 vertex in new[] { a,ab,ca, b,bc,ab, c,ca,bc, ab,bc,ca })
                {
                    indices.Add(subdivided.Count);
                    subdivided.Add(vertex);
                }
            }
            return FlatMesh("Faceted organic volume", subdivided.ToArray(), indices.ToArray());
        }

        private static Mesh FlatMesh(string name, Vector3[] sourceVertices, int[] sourceTriangles)
        {
            var vertices = new Vector3[sourceTriangles.Length];
            var triangles = new int[sourceTriangles.Length];
            var uv = new Vector2[sourceTriangles.Length];
            for (int i = 0; i < triangles.Length; i++)
            {
                vertices[i] = sourceVertices[sourceTriangles[i]];
                triangles[i] = i;
                uv[i] = new Vector2(vertices[i].x, vertices[i].z);
            }
            var mesh = new Mesh { name = name, vertices = vertices, triangles = triangles, uv = uv };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            mesh.RecalculateTangents();
            return mesh;
        }

        private sealed class Palette
        {
            public readonly Material Grass, Path, Water, Wood, WoodLight, Plaster, Roof;
            public readonly Material Leaf, LeafLight, LeafDark, Stone, StoneLight, Copper, Iron, Dark, Glow;

            public Palette(string folder, Shader shader)
            {
                Grass = Make(folder, shader, "Grass", "738854");
                Path = Make(folder, shader, "Warm path", "B5A277");
                Water = Make(folder, shader, "Pond water", "4B9299", 0.55f);
                Wood = Make(folder, shader, "Walnut timber", "705139");
                WoodLight = Make(folder, shader, "Honey wood", "B28B55");
                Plaster = Make(folder, shader, "Cream plaster", "D9C99B");
                Roof = Make(folder, shader, "Moss roof", "45624E");
                Leaf = Make(folder, shader, "Moss green", "69834A");
                LeafLight = Make(folder, shader, "Fresh growth", "9BB45F");
                LeafDark = Make(folder, shader, "Forest green", "3D6047");
                Stone = Make(folder, shader, "Slate stone", "788077");
                StoneLight = Make(folder, shader, "Limestone", "A3A28A");
                Copper = Make(folder, shader, "Aged copper", "AF7850", 0.2f, 0.28f);
                Iron = Make(folder, shader, "Forged iron", "414B4C", 0.32f, 0.6f);
                Dark = Make(folder, shader, "Deep recess", "29342F");
                Glow = Make(folder, shader, "Amber glass", "FFD789", 0.3f);
                Glow.EnableKeyword("_EMISSION");
                Glow.SetColor("_EmissionColor", new Color(1.2f, 0.58f, 0.14f));
                Glow.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
                EditorUtility.SetDirty(Glow);
            }

            private static Material Make(string folder, Shader shader, string name, string hex,
                float smoothness = 0.12f, float metallic = 0)
            {
                ColorUtility.TryParseHtmlString("#" + hex, out Color color);
                var material = new Material(shader) { name = name, enableInstancing = true };
                material.SetColor("_BaseColor", color);
                material.SetFloat("_Smoothness", smoothness);
                material.SetFloat("_Metallic", metallic);
                AssetDatabase.CreateAsset(material, folder + "/" + name.Replace(" ", "") + ".mat");
                return material;
            }
        }
    }
}
