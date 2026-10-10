using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    public sealed class GroundMaterialSet
    {
        // This order is also the alphamap channel order in GroundTerrainBuilder.
        public TerrainLayer[] Layers;
        public Material Material;
    }

    /// <summary>
    /// Original, repeatable starter surfaces. Texture pixels contain colour only;
    /// the terrain geometry, scene lights and shadows provide the illumination.
    /// This editor-only factory saves ordinary PNGs/TerrainLayers for later painting.
    /// </summary>
    public static class GroundMaterialFactory
    {
        private const int Resolution = 256;
        private const float TileMetres = 4f;
        private const string TerrainShaderName = "Universal Render Pipeline/Terrain/Lit";

        public static GroundMaterialSet Create(string assetFolder, bool blockoutPalette = false)
        {
            string folder = ValidateEmptyFolder(assetFolder);
            Shader shader = Shader.Find(TerrainShaderName);
            if (shader == null)
                throw new InvalidOperationException("URP Terrain/Lit is unavailable. Wait for URP to finish importing.");

            // A shared palette keeps transitions quiet instead of exposing four unrelated tiles.
            // The contour layout uses deliberate value separation: pale clearings and
            // paths against dark forest ground. Existing scenes keep their original palette.
            var surfaces = blockoutPalette ? new[]
            {
                new Surface("Meadow", new Color32(141, 158, 102, 255),
                    new Color32(151, 170, 113, 255), new Color32(124, 144, 90, 255), 17, 0.10f),
                new Surface("Moss", new Color32(57, 86, 64, 255),
                    new Color32(73, 101, 71, 255), new Color32(45, 69, 54, 255), 53, 0.12f),
                new Surface("Soil", new Color32(173, 149, 111, 255),
                    new Color32(190, 166, 127, 255), new Color32(149, 126, 95, 255), 97, 0.06f),
                new Surface("LeafLitter", new Color32(65, 82, 56, 255),
                    new Color32(80, 97, 65, 255), new Color32(48, 65, 44, 255), 151, 0.08f)
            } : new[]
            {
                new Surface("Meadow", new Color32(107, 137, 88, 255),
                    new Color32(139, 160, 105, 255), new Color32(75, 110, 69, 255), 17, 0.10f),
                new Surface("Moss", new Color32(83, 115, 76, 255),
                    new Color32(118, 145, 90, 255), new Color32(66, 91, 65, 255), 53, 0.12f),
                new Surface("Soil", new Color32(137, 113, 87, 255),
                    new Color32(166, 141, 107, 255), new Color32(105, 86, 69, 255), 97, 0.06f),
                new Surface("LeafLitter", new Color32(115, 105, 76, 255),
                    new Color32(156, 132, 89, 255), new Color32(79, 88, 60, 255), 151, 0.08f)
            };

            var layers = new TerrainLayer[surfaces.Length];
            for (int index = 0; index < surfaces.Length; index++)
            {
                Surface surface = surfaces[index];
                Texture2D albedo = CreateTexture(folder, surface, index);
                var layer = new TerrainLayer
                {
                    name = surface.Name,
                    diffuseTexture = albedo,
                    tileSize = Vector2.one * TileMetres,
                    tileOffset = Vector2.zero,
                    metallic = 0f,
                    smoothness = surface.Smoothness,
                    diffuseRemapMin = Vector4.zero,
                    diffuseRemapMax = Vector4.one
                };
                string layerPath = folder + "/" + surface.Name + ".terrainlayer";
                AssetDatabase.CreateAsset(layer, layerPath);
                layers[index] = layer;
            }

            var material = new Material(shader)
            {
                name = "Forest Terrain",
                enableInstancing = true
            };
            // Both the property default and this keyword are defined by URP 17.3's
            // TerrainLit.shader. Let terrain normals follow the full heightmap.
            material.EnableKeyword("_TERRAIN_INSTANCED_PERPIXEL_NORMAL");
            AssetDatabase.CreateAsset(material, folder + "/ForestTerrain.mat");
            AssetDatabase.SaveAssets();
            return new GroundMaterialSet { Layers = layers, Material = material };
        }

        private static string ValidateEmptyFolder(string assetFolder)
        {
            if (string.IsNullOrWhiteSpace(assetFolder) ||
                !assetFolder.StartsWith("Assets/", StringComparison.Ordinal) ||
                assetFolder.Contains("..") || assetFolder.Contains("\\"))
                throw new ArgumentException("Use an existing empty subfolder beneath Assets/.", nameof(assetFolder));

            string folder = assetFolder.TrimEnd('/');
            string fullPath = Path.GetFullPath(Path.Combine(Application.dataPath, "..", folder));
            if (!AssetDatabase.IsValidFolder(folder) || !Directory.Exists(fullPath))
                throw new ArgumentException("Create the ground material folder first: " + folder, nameof(assetFolder));
            if (Directory.GetFileSystemEntries(fullPath).Length != 0 ||
                AssetDatabase.FindAssets("", new[] { folder }).Length != 0)
                throw new InvalidOperationException("Ground material folder must be empty. Existing assets are preserved: " + folder);
            return folder;
        }

        private static Texture2D CreateTexture(string folder, Surface surface, int kind)
        {
            var pixels = new Color[Resolution * Resolution];
            for (int y = 0; y < Resolution; y++)
            for (int x = 0; x < Resolution; x++)
            {
                float u = x / (float)Resolution;
                float v = y / (float)Resolution;
                float broad = PeriodicNoise(u, v, 4, surface.Seed) - 0.5f;
                float patches = PeriodicNoise(u, v, 11, surface.Seed + 1) - 0.5f;
                float grain = PeriodicNoise(u, v, 39, surface.Seed + 2) - 0.5f;
                float fine = PeriodicNoise(u, v, 91, surface.Seed + 3) - 0.5f;
                float variation = broad * 0.080f + patches * 0.060f + grain * 0.034f + fine * 0.020f;
                Color colour = surface.Base;
                colour.r = Mathf.Clamp01(colour.r + variation);
                colour.g = Mathf.Clamp01(colour.g + variation * 0.94f);
                colour.b = Mathf.Clamp01(colour.b + variation * 0.75f);
                pixels[y * Resolution + x] = colour;
            }

            // Every stamp wraps at the tile boundary, just like the periodic noise.
            // No directional highlights or cast shadows are baked into these marks.
            var random = new System.Random(surface.Seed);
            int count = kind == 0 ? 1050 : kind == 1 ? 1250 : kind == 2 ? 1050 : 590;
            for (int mark = 0; mark < count; mark++)
            {
                float x = Next(random, 0f, Resolution);
                float y = Next(random, 0f, Resolution);
                float angle = Next(random, 0f, Mathf.PI * 2f);
                Color colour = random.NextDouble() < 0.5 ? surface.Light : surface.Dark;
                if (kind == 0)
                {
                    Stamp(pixels, x, y, Next(random, 0.52f, 1.05f), Next(random, 1.4f, 3.2f),
                        angle, colour, Next(random, 0.18f, 0.40f), true);
                }
                else if (kind == 1)
                {
                    Stamp(pixels, x, y, Next(random, 0.75f, 1.65f), Next(random, 0.8f, 2.0f),
                        angle, colour, Next(random, 0.16f, 0.34f), false);
                }
                else if (kind == 2)
                {
                    // Fine aggregate, with occasional larger worn pebbles.
                    float radius = mark % 23 == 0 ? Next(random, 1.3f, 2.4f) : Next(random, 0.4f, 1.0f);
                    Stamp(pixels, x, y, radius, radius * Next(random, 0.65f, 1.15f),
                        angle, colour, Next(random, 0.16f, 0.36f), false);
                }
                else
                {
                    // Muted fallen leaves remain subordinate to the readable path.
                    Stamp(pixels, x, y, Next(random, 0.75f, 1.7f), Next(random, 1.4f, 3.6f),
                        angle, colour, Next(random, 0.23f, 0.49f), true);
                }
            }

            string assetPath = folder + "/" + surface.Name + "Albedo.png";
            string fullPath = Path.GetFullPath(Path.Combine(Application.dataPath, "..", assetPath));
            // RGB is intentional: URP interprets albedo alpha as smoothness when
            // present. RGB lets the TerrainLayer's low smoothness remain effective.
            var texture = new Texture2D(Resolution, Resolution, TextureFormat.RGB24, false, false);
            try
            {
                texture.SetPixels(pixels);
                texture.Apply(false, false);
                using (var stream = new FileStream(fullPath, FileMode.CreateNew, FileAccess.Write))
                {
                    byte[] png = texture.EncodeToPNG();
                    stream.Write(png, 0, png.Length);
                }
            }
            finally
            {
                Object.DestroyImmediate(texture);
            }

            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
                throw new InvalidOperationException("Unity could not import the generated ground texture: " + assetPath);
            importer.textureType = TextureImporterType.Default;
            importer.sRGBTexture = true;
            importer.alphaSource = TextureImporterAlphaSource.None;
            importer.mipmapEnabled = true;
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.filterMode = FilterMode.Bilinear;
            importer.anisoLevel = 4;
            importer.isReadable = false;
            importer.maxTextureSize = Resolution;
            importer.textureCompression = TextureImporterCompression.Compressed;
            importer.compressionQuality = 75;
            importer.SaveAndReimport();
            Texture2D imported = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (imported == null)
                throw new InvalidOperationException("Generated ground texture is missing after import: " + assetPath);
            return imported;
        }

        private static void Stamp(Color[] pixels, float centreX, float centreY, float width, float length,
            float angle, Color colour, float opacity, bool pointed)
        {
            float cos = Mathf.Cos(angle);
            float sin = Mathf.Sin(angle);
            int extent = Mathf.CeilToInt(Mathf.Max(width, length) + 1f);
            for (int y = Mathf.FloorToInt(centreY) - extent; y <= Mathf.CeilToInt(centreY) + extent; y++)
            for (int x = Mathf.FloorToInt(centreX) - extent; x <= Mathf.CeilToInt(centreX) + extent; x++)
            {
                float dx = x + 0.5f - centreX;
                float dy = y + 0.5f - centreY;
                float across = (dx * cos - dy * sin) / width;
                float along = (dx * sin + dy * cos) / length;
                float distance = pointed
                    ? Mathf.Abs(across) + along * along
                    : across * across + along * along;
                float coverage = 1f - Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.28f, 1.16f, distance));
                if (coverage <= 0f) continue;
                int pixel = Wrap(y, Resolution) * Resolution + Wrap(x, Resolution);
                pixels[pixel] = Color.Lerp(pixels[pixel], colour, coverage * opacity);
            }
        }

        private static float PeriodicNoise(float u, float v, int period, int seed)
        {
            float x = u * period;
            float y = v * period;
            int ix = Mathf.FloorToInt(x);
            int iy = Mathf.FloorToInt(y);
            float tx = Smooth(x - ix);
            float ty = Smooth(y - iy);
            float bottom = Mathf.Lerp(Hash(Wrap(ix, period), Wrap(iy, period), seed),
                Hash(Wrap(ix + 1, period), Wrap(iy, period), seed), tx);
            float top = Mathf.Lerp(Hash(Wrap(ix, period), Wrap(iy + 1, period), seed),
                Hash(Wrap(ix + 1, period), Wrap(iy + 1, period), seed), tx);
            return Mathf.Lerp(bottom, top, ty);
        }

        private static float Hash(int x, int y, int seed)
        {
            unchecked
            {
                uint value = (uint)x * 374761393u + (uint)y * 668265263u + (uint)seed * 1442695041u;
                value = (value ^ (value >> 13)) * 1274126177u;
                value ^= value >> 16;
                return (value & 0x00ffffffu) / 16777215f;
            }
        }

        private static float Smooth(float value) => value * value * value * (value * (value * 6f - 15f) + 10f);
        private static int Wrap(int value, int period) => (value % period + period) % period;
        private static float Next(System.Random random, float minimum, float maximum) =>
            Mathf.Lerp(minimum, maximum, (float)random.NextDouble());

        private sealed class Surface
        {
            public readonly string Name;
            public readonly Color Base;
            public readonly Color Light;
            public readonly Color Dark;
            public readonly int Seed;
            public readonly float Smoothness;

            public Surface(string name, Color baseColour, Color light, Color dark, int seed, float smoothness)
            {
                Name = name;
                Base = baseColour;
                Light = light;
                Dark = dark;
                Seed = seed;
                Smoothness = smoothness;
            }
        }
    }
}
