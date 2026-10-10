using System;
using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Explicit recipe-to-Terrain bake. Never runs on import, enable, or Play.</summary>
    public static class GroundTerrainBaker
    {
        public const int HeightResolution = 257;
        public const int PaintResolution = 512;
        public const int LayerCount = 4;

        public static Terrain Create(GroundRecipe recipe, string assetFolder, TerrainLayer[] layers, Material material,
            int heightResolution = HeightResolution, int paintResolution = PaintResolution)
        {
            GroundPathMath.ValidateRecipe(recipe);
            if (heightResolution < 33 || heightResolution > 4097 || !Mathf.IsPowerOfTwo(heightResolution - 1))
                throw new ArgumentException("Height resolution must be a power of two plus one, from 33 to 4097.", nameof(heightResolution));
            if (paintResolution < 16 || paintResolution > 2048 || !Mathf.IsPowerOfTwo(paintResolution))
                throw new ArgumentException("Paint resolution must be a power of two, from 16 to 2048.", nameof(paintResolution));
            if (string.IsNullOrWhiteSpace(assetFolder) || !AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create a valid Assets folder before baking the ground.", nameof(assetFolder));
            if (material == null || material.shader == null)
                throw new ArgumentException("A URP Terrain material is required.", nameof(material));
            ValidateLayers(layers);

            var sampler = new GroundPathMath(recipe);
            float[,] heightmap = Heights(recipe, sampler, heightResolution);
            float[,,] paintmap = Paint(recipe, sampler, paintResolution);
            var data = new TerrainData
            {
                name = "Clearing Ground",
                heightmapResolution = heightResolution,
                alphamapResolution = paintResolution,
                baseMapResolution = Mathf.Min(1024, paintResolution),
                size = recipe.Size,
                terrainLayers = layers
            };
            // All validation and field calculation finishes before writing assets or changing the scene.
            data.SetHeights(0, 0, heightmap);
            data.SetAlphamaps(0, 0, paintmap);
            string path = AssetDatabase.GenerateUniqueAssetPath(assetFolder + "/ClearingGround.asset");
            AssetDatabase.CreateAsset(data, path);
            GameObject gameObject = Terrain.CreateTerrainGameObject(data);
            gameObject.name = "Ground Surface";
            gameObject.layer = 8;
            gameObject.transform.position = recipe.Origin;
            Terrain terrain = gameObject.GetComponent<Terrain>();
            terrain.materialTemplate = material;
            terrain.drawInstanced = true;
            terrain.heightmapPixelError = 3f;
            terrain.basemapDistance = 80f;
            terrain.allowAutoConnect = false;
            var authoring = gameObject.AddComponent<GroundAuthoring>();
            authoring.Surface = terrain;
            authoring.Recipe = recipe;
            terrain.Flush();
            EditorUtility.SetDirty(data);
            return terrain;
        }

        public static void Bake(Terrain terrain, GroundRecipe recipe, bool heights, bool paint)
        {
            if (!heights && !paint) return;
            GroundPathMath.ValidateRecipe(recipe);
            if (terrain == null || terrain.terrainData == null)
                throw new ArgumentException("Select a Terrain with TerrainData before baking.", nameof(terrain));
            TerrainData data = terrain.terrainData;
            ValidateLayers(data.terrainLayers);
            if ((terrain.transform.position - recipe.Origin).sqrMagnitude > .000001f ||
                (data.size - recipe.Size).sqrMagnitude > .000001f ||
                Quaternion.Angle(terrain.transform.rotation, Quaternion.identity) > .001f ||
                (terrain.transform.lossyScale - Vector3.one).sqrMagnitude > .000001f)
                throw new ArgumentException("Terrain origin/size must match its recipe, with no rotation or scale. " +
                    "A partial rebake never moves or resizes manually edited ground.");
            var sampler = new GroundPathMath(recipe);
            float[,] heightmap = heights ? Heights(recipe, sampler, data.heightmapResolution) : null;
            float[,,] paintmap = paint ? Paint(recipe, sampler, data.alphamapResolution) : null;
            // Undo is registered after complete validation/sampling and before mutating native TerrainData.
            string undoName = heights && paint ? "Bake ground recipe" :
                heights ? "Bake ground relief" : "Bake ground paint";
            if (paint)
            {
                // Terrain stores control-map pixels in separate textures; recording only TerrainData
                // does not preserve manually painted pixels when Undo is used.
                Texture2D[] maps = data.alphamapTextures;
                var undoObjects = new UnityEngine.Object[maps.Length + 1];
                undoObjects[0] = data;
                for (int i = 0; i < maps.Length; i++) undoObjects[i + 1] = maps[i];
                Undo.RegisterCompleteObjectUndo(undoObjects, undoName);
            }
            else Undo.RegisterCompleteObjectUndo(data, undoName);
            if (heights) data.SetHeights(0, 0, heightmap);
            if (paint) data.SetAlphamaps(0, 0, paintmap);
            terrain.Flush();
            EditorUtility.SetDirty(data);
        }

        private static float[,] Heights(GroundRecipe recipe, GroundPathMath sampler, int resolution)
        {
            var values = new float[resolution, resolution];
            for (int z = 0; z < resolution; z++)
                for (int x = 0; x < resolution; x++)
                {
                    Vector2 point = WorldPoint(recipe, x / (float)(resolution - 1), z / (float)(resolution - 1));
                    float value = (sampler.SampleHeight(point) - recipe.Origin.y) / recipe.Size.y;
                    if (float.IsNaN(value) || float.IsInfinity(value))
                        throw new InvalidOperationException("Ground sampling produced a non-finite height.");
                    values[z, x] = Mathf.Clamp01(value);
                }
            return values;
        }

        private static float[,,] Paint(GroundRecipe recipe, GroundPathMath sampler, int resolution)
        {
            var values = new float[resolution, resolution, LayerCount];
            for (int z = 0; z < resolution; z++)
                for (int x = 0; x < resolution; x++)
                {
                    // Alphamap texels sample their centres; heightmap samples include both outer edges.
                    Vector2 point = WorldPoint(recipe, (x + .5f) / resolution, (z + .5f) / resolution);
                    sampler.SampleLayerWeights(point, out float meadow, out float moss, out float soil, out float leafLitter);
                    float sum = meadow + moss + soil + leafLitter;
                    if (float.IsNaN(sum) || float.IsInfinity(sum) || Mathf.Abs(sum - 1f) > .0001f)
                        throw new InvalidOperationException("Ground paint weights must be finite and sum to one.");
                    values[z, x, 0] = meadow;
                    values[z, x, 1] = moss;
                    values[z, x, 2] = soil;
                    values[z, x, 3] = leafLitter;
                }
            return values;
        }

        private static Vector2 WorldPoint(GroundRecipe recipe, float x, float z)
        {
            return new Vector2(recipe.Origin.x + recipe.Size.x * x, recipe.Origin.z + recipe.Size.z * z);
        }

        private static void ValidateLayers(TerrainLayer[] layers)
        {
            if (layers == null || layers.Length != LayerCount)
                throw new ArgumentException("Ground layers must be Meadow, Moss, Soil, Leaf Litter in that order.");
            for (int i = 0; i < layers.Length; i++)
                if (layers[i] == null || layers[i].diffuseTexture == null)
                    throw new ArgumentException("Every ground TerrainLayer requires a diffuse texture.");
        }
    }
}
