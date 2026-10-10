using System;
using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    public static class GroundValidation
    {
        [MenuItem("Zhiv/Validate Ground and Paths", priority = 11)]
        public static void ValidateOpenGround()
        {
            var authoring = Object.FindFirstObjectByType<GroundAuthoring>();
            Require(authoring != null && authoring.Surface != null && authoring.Recipe != null, "GroundAuthoring references");
            Terrain terrain = authoring.Surface;
            GroundRecipe recipe = authoring.Recipe;
            var sampler = new GroundPathMath(recipe);
            var repeated = new GroundPathMath(recipe);
            Require(terrain.gameObject.layer == 8, "Ground layer");
            Require(terrain.GetComponent<TerrainCollider>()?.terrainData == terrain.terrainData, "Matching TerrainCollider");
            Require(terrain.materialTemplate != null && terrain.materialTemplate.shader.name == "Universal Render Pipeline/Terrain/Lit", "URP Terrain material");
            Require(terrain.terrainData.terrainLayers.Length == 4, "Four terrain layers");
            Require(AssetDatabase.Contains(terrain.terrainData) && AssetDatabase.Contains(recipe), "Persistent terrain and recipe");
            Require((terrain.transform.position - recipe.Origin).sqrMagnitude < .000001f &&
                (terrain.terrainData.size - recipe.Size).sqrMagnitude < .000001f, "Recipe and terrain bounds match");

            for (int z = 0; z <= 20; z++)
            for (int x = 0; x <= 18; x++)
            {
                var point = new Vector2(recipe.Origin.x + recipe.Size.x * x / 18f,
                    recipe.Origin.z + recipe.Size.z * z / 20f);
                float height = sampler.SampleHeight(point);
                Require(!float.IsNaN(height) && !float.IsInfinity(height) && height >= recipe.Origin.y &&
                    height <= recipe.Origin.y + recipe.Size.y, "Finite height within terrain range");
                Require(Mathf.Abs(height - repeated.SampleHeight(point)) < .000001f, "Deterministic recipe");
                sampler.SampleLayerWeights(point, out float meadow, out float moss, out float soil, out float litter);
                Require(meadow >= 0 && moss >= 0 && soil >= 0 && litter >= 0 &&
                    Mathf.Abs(meadow + moss + soil + litter - 1) < .0001f, "Nonnegative normalized layer weights");
            }
            for (int i = 0; i < recipe.Trails.Count; i++)
            foreach (Vector2 point in sampler.GetTrailPoints(i))
                Require(sampler.SamplePathWeight(point) > .999f, "Continuous worn path centre");

            // Validate stored paint, independent of recipe, so manual brush edits remain supported.
            int resolution = terrain.terrainData.alphamapResolution;
            for (int z = 0; z < resolution; z += 47)
            for (int x = 0; x < resolution; x += 43)
            {
                float[,,] weights = terrain.terrainData.GetAlphamaps(x, z, 1, 1);
                float total = 0;
                for (int layer = 0; layer < 4; layer++)
                {
                    Require(weights[0, 0, layer] >= 0, "Stored layer weight is nonnegative");
                    total += weights[0, 0, layer];
                }
                Require(Mathf.Abs(total - 1) < .02f, "Stored layer weights sum to one");
            }
            foreach (GridNavigator navigator in Object.FindObjectsByType<GridNavigator>(FindObjectsSortMode.None))
            {
                if (navigator.gameObject.scene != authoring.gameObject.scene) continue;
                var serialized = new SerializedObject(navigator);
                Require(serialized.FindProperty("groundTerrain").objectReferenceValue == terrain, "Navigation uses this terrain");
                var point = new Vector3(recipe.Origin.x + recipe.Size.x * .37f, 100, recipe.Origin.z + recipe.Size.z * .63f);
                Require(Mathf.Abs(navigator.ProjectToGround(point).y - (terrain.SampleHeight(point) + terrain.transform.position.y)) < .0001f,
                    "Navigation includes terrain world Y offset");
            }
            Debug.Log("ZHIV GROUND VALIDATION PASSED: Terrain references, normalized paint, continuous paths, deterministic relief and navigation height. Visuals/gestures still need Play Mode.");
        }

        public static void ValidateFromBatch()
        {
            PrototypeSceneBuilder.CreateForBatch();
            UnityEditor.SceneManagement.EditorSceneManager.OpenScene(PrototypeSceneBuilder.ScenePath);
            GroundSceneUpgrade.UpgradeOpenClearing();
            ValidateOpenGround();
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("ZHIV GROUND VALIDATION FAILED: " + message);
        }
    }
}
