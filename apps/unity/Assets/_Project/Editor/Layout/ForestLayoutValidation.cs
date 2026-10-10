using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using Zhiv.WorldPrototype;
using Zhiv.WorldPrototype.UI;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    public static class ForestLayoutValidation
    {
        [MenuItem("Zhiv/Validate Forest Layout", priority = 12)]
        public static void ValidateOpenScene()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Останови Play перед проверкой сохранённой планировки.");
            Require(EditorSceneManager.GetActiveScene().path == ForestLayoutSceneBuilder.ScenePath,
                "Open ForestLayout.unity before validating");
            var expanded = Object.FindFirstObjectByType<ForestWorldMap>();
            if (expanded != null)
            {
                ExpandedForestValidation.ValidateMap(expanded, true);
                return;
            }
            GroundValidation.ValidateOpenGround();
            var actor = Object.FindFirstObjectByType<WorldActorController>();
            var navigation = Object.FindFirstObjectByType<GridNavigator>();
            var camera = Object.FindFirstObjectByType<FixedWorldCamera>();
            var hud = Object.FindFirstObjectByType<ForestHud>();
            Require(actor != null && navigation != null && camera != null && hud != null, "Scene systems exist");
            Require(Object.FindObjectsByType<EventSystem>(FindObjectsSortMode.None).Length == 1, "One EventSystem");
            Require(hud.GetComponent<Canvas>() != null && hud.GetComponent<CanvasScaler>() != null,
                "Native scalable Canvas");
            Require(hud.GetComponentsInChildren<Button>(true).Length >= 3, "HUD buttons saved in scene");

            foreach (GameObject root in EditorSceneManager.GetActiveScene().GetRootGameObjects())
            foreach (Transform child in root.GetComponentsInChildren<Transform>(true))
            {
                Require(GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(child.gameObject) == 0,
                    "No missing scripts on " + child.name);
                var mesh = child.GetComponent<MeshFilter>();
                if (mesh != null) Require(mesh.sharedMesh != null && EditorUtility.IsPersistent(mesh.sharedMesh),
                    "Saved mesh on " + child.name);
                var renderer = child.GetComponent<Renderer>();
                if (renderer == null) continue;
                foreach (Material material in renderer.sharedMaterials)
                    Require(material != null && material.shader != null && EditorUtility.IsPersistent(material),
                        "Saved material on " + child.name);
            }

            navigation.Rebuild();
            GroundRecipe recipe = Object.FindFirstObjectByType<GroundAuthoring>().Recipe;
            var curves = new GroundPathMath(recipe);
            for (int trailIndex = 0; trailIndex < recipe.Trails.Count; trailIndex++)
            {
                IReadOnlyList<Vector2> points = curves.GetTrailPoints(trailIndex);
                for (int i = 1; i < points.Count; i++)
                {
                    var from = new Vector3(points[i - 1].x, 0, points[i - 1].y);
                    var to = new Vector3(points[i].x, 0, points[i].y);
                    Require(navigation.SegmentClear(from, to), "Painted path is clear: " + recipe.Trails[trailIndex].Name +
                        " at " + points[i] + " (adjust trail points or move the obstacle)");
                }
            }
            var landmarks = Object.FindObjectsByType<ForestLandmark>(FindObjectsSortMode.None);
            Require(landmarks.Length >= 7, "All seven places have arrival markers");
            var ids = new HashSet<string>();
            var path = new List<Vector3>();
            foreach (ForestLandmark landmark in landmarks)
            {
                Require(!string.IsNullOrWhiteSpace(landmark.Id) && ids.Add(landmark.Id), "Unique landmark id");
                Require(landmark.Arrival != null, "Arrival marker for " + landmark.Id);
                Require(navigation.TryFindPath(actor.transform.position, landmark.Arrival.position, path),
                    "Walkable route to " + landmark.DisplayName + " (move Arrival or remove blocking objects)");
                Vector3 previous = actor.transform.position;
                foreach (Vector3 point in path)
                {
                    Require(navigation.SegmentClear(previous, point), "Continuous clearance to " + landmark.Id);
                    previous = point;
                }
            }
            // Water is a blocked volume, not only a visual plane above the sunken Terrain.
            Vector2 lake = ForestLayoutRecipe.LakeCenter;
            Require(!navigation.TryFindPath(actor.transform.position, new Vector3(lake.x, 0, lake.y), path),
                "Lake interior is not walkable");
            Require(!navigation.TryFindPath(actor.transform.position, new Vector3(100, 0, 100), path),
                "Outside world is unreachable");
            Debug.Log("ZHIV FOREST VALIDATION PASSED: saved assets, terrain, Canvas, unique places, " +
                "clear painted trails, routes to seven arrival markers, blocked lake. Still check appearance, UI gestures and speed on a phone.");
        }

        public static void ValidateFromBatch()
        {
            if (!File.Exists(ForestLayoutSceneBuilder.ScenePath)) ForestLayoutSceneBuilder.CreateForBatch();
            EditorSceneManager.OpenScene(ForestLayoutSceneBuilder.ScenePath);
            ValidateOpenScene();
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("ZHIV FOREST VALIDATION FAILED: " + message);
        }
    }
}
