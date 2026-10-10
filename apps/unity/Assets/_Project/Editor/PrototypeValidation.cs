using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Editor smoke check, including real collider queries; this is not a visual/device test.</summary>
    public static class PrototypeValidation
    {
        [MenuItem("Zhiv/Validate Open Clearing", priority = 10)]
        public static void ValidateOpenScene()
        {
            if (EditorSceneManager.GetActiveScene().path != PrototypeSceneBuilder.ScenePath)
                throw new InvalidOperationException("Сначала открой Assets/_Project/Scenes/Clearing.unity.");
            Require(GraphicsSettings.defaultRenderPipeline != null, "URP asset is assigned");
            var camera = UnityEngine.Object.FindFirstObjectByType<FixedWorldCamera>();
            var actor = UnityEngine.Object.FindFirstObjectByType<WorldActorController>();
            var navigation = UnityEngine.Object.FindFirstObjectByType<GridNavigator>();
            var interaction = UnityEngine.Object.FindFirstObjectByType<DemoInteraction>();
            Require(camera != null && actor != null && navigation != null && interaction != null,
                "Camera, actor, navigator and interaction exist");
            Require(camera.GetComponent<Camera>().orthographic, "Camera is orthographic");
            Require(LayerMask.LayerToName(8) == "Ground" && LayerMask.LayerToName(9) == "Obstacle", "World layers exist");
            foreach (var root in EditorSceneManager.GetActiveScene().GetRootGameObjects())
            foreach (var transform in root.GetComponentsInChildren<Transform>(true))
            {
                Require(GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject) == 0,
                    "No missing scripts on " + transform.name);
                var renderer = transform.GetComponent<Renderer>();
                if (renderer == null) continue;
                foreach (Material material in renderer.sharedMaterials)
                    Require(material != null && material.shader != null && AssetDatabase.Contains(material),
                        "Persistent material on " + transform.name);
            }

            // These positions match the initial scene. If you redesign the clearing, update the fixture.
            navigation.Rebuild();
            var start = new Vector3(-6, 0, 0);
            var finish = new Vector3(-6, 0, 8);
            Require(!navigation.SegmentClear(start, finish), "Workshop blocks the direct route");
            var path = new List<Vector3>();
            Require(navigation.TryFindPath(start, finish, path), "A route exists around the workshop");
            Require(path.Count > 1, "The route goes around the building");
            Vector3 previous = start;
            foreach (Vector3 point in path)
            {
                Require(navigation.SegmentClear(previous, point), "Every route segment has body clearance");
                previous = point;
            }
            Require(!navigation.TryFindPath(start, new Vector3(-6, 0, 4), path), "Building interior is unreachable");
            Require(!navigation.TryFindPath(start, new Vector3(100, 0, 100), path), "Outside world is unreachable");
            Require(!navigation.TryFindPath(start, new Vector3(9, 0, -7), path), "Pond is unreachable");
            Debug.Log("ZHIV VALIDATION PASSED: scene references, materials, layers, orthographic camera, workshop detour and blocked destinations. Still test Play Mode and a real phone.");
        }

        public static void ValidateFromBatch()
        {
            if (!File.Exists(PrototypeSceneBuilder.ScenePath)) PrototypeSceneBuilder.CreateForBatch();
            EditorSceneManager.OpenScene(PrototypeSceneBuilder.ScenePath);
            ValidateOpenScene();
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("ZHIV VALIDATION FAILED: " + message);
        }
    }
}
