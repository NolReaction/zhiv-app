using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using Zhiv.WorldPrototype;
using Zhiv.WorldPrototype.UI;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Runs before replacing the small scene and on demand after authoring edits.</summary>
    public static class ExpandedForestValidation
    {
        public static void ValidateMap(ForestWorldMap map, bool routes)
        {
            Require(map != null && map.Revision >= ForestWorldMap.CurrentRevision, "Expanded map revision");
            GroundValidation.ValidateOpenGround();
            Require(map.Ground != null && map.Ground.Surface != null && map.Ground.Recipe != null,
                "Saved map ground references");
            GroundRecipe recipe = map.Ground.Recipe;
            Terrain terrain = map.Ground.Surface;
            Require(recipe.Size.x >= 280 && recipe.Size.z >= 280, "280 m terrain and camera buffer");
            Require(terrain.terrainData.heightmapResolution >= 513 && terrain.terrainData.alphamapResolution >= 1024,
                "Terrain resolution supports the enlarged layout");
            Require(recipe.WaterRegions != null && recipe.WaterRegions.Count > 0, "Coast recipe");
            Require(map.WalkBoundary != null && map.WalkBoundary.Length >= 3, "Playable boundary");
            var navigation = Object.FindFirstObjectByType<GridNavigator>();
            var actor = Object.FindFirstObjectByType<WorldActorController>();
            var camera = Object.FindFirstObjectByType<FixedWorldCamera>();
            var hud = Object.FindFirstObjectByType<ForestHud>();
            Require(navigation != null && actor != null && camera != null && hud != null, "World systems");
            Require(Object.FindObjectsByType<EventSystem>(FindObjectsSortMode.None).Length == 1, "One EventSystem");
            Require(hud.GetComponent<Canvas>() != null && hud.GetComponent<CanvasScaler>() != null,
                "Native scalable Canvas");
            Require(hud.GetComponentInChildren<ForestMapPanel>(true) != null, "Map panel with place links");
            Require(map.Places != null && map.Places.Length >= 13, "Thirteen saved places");
            Require(map.TreeCount > 1000 && map.ForestPatchCount > 0 && map.EditableTreeCount > 0,
                "Both editable forest edges and combined background forest exist");
            ValidateAssets(map);

            var curves = new GroundPathMath(recipe);
            var ids = new HashSet<string>();
            foreach (ForestLandmark place in map.Places)
            {
                Require(place != null && !string.IsNullOrWhiteSpace(place.Id) && ids.Add(place.Id), "Unique place ID");
                Require(place.Arrival != null && place.Arrival.IsChildOf(place.transform), "Arrival for " + place.Id);
                Require(place.Footprint.x > 0 && place.Footprint.y > 0, "Footprint for " + place.Id);
                for (int z = 0; z <= 4; z++)
                for (int x = 0; x <= 4; x++)
                {
                    Vector3 point = place.transform.TransformPoint(new Vector3(
                        (x / 4f - .5f) * place.Footprint.x, 0, (z / 4f - .5f) * place.Footprint.y));
                    Require(!curves.IsWater(new Vector2(point.x, point.z), .35f),
                        "Dry building footprint: " + place.DisplayName);
                }
            }
            if (!routes) return;
            navigation.Rebuild();
            for (int trail = 0; trail < recipe.Trails.Count; trail++)
            {
                IReadOnlyList<Vector2> points = curves.GetTrailPoints(trail);
                for (int i = 1; i < points.Count; i++)
                {
                    var from = new Vector3(points[i - 1].x, 0, points[i - 1].y);
                    var to = new Vector3(points[i].x, 0, points[i].y);
                    Require(navigation.SegmentClear(from, to), "Clear painted trail: " +
                        recipe.Trails[trail].Name + " at " + points[i] + " (move the obstacle or path point)");
                }
            }
            var path = new List<Vector3>();
            double longestSearch = 0;
            int mostCells = 0;
            foreach (ForestLandmark place in map.Places)
            {
                Require(navigation.TryFindPath(actor.transform.position, place.Arrival.position, path),
                    "Reachable arrival: " + place.DisplayName);
                longestSearch = Math.Max(longestSearch, navigation.LastSearchMilliseconds);
                mostCells = Math.Max(mostCells, navigation.LastExpandedCellCount);
                Vector3 previous = actor.transform.position;
                foreach (Vector3 point in path)
                {
                    Require(navigation.SegmentClear(previous, point), "Continuous body clearance to " + place.Id);
                    previous = point;
                }
            }
            // Test water inside the playable region, rather than a point already rejected by the boundary.
            int checkedWater = 0;
            for (float v = -64; v <= 56 && checkedWater < 8; v += 8)
            for (float u = -56; u <= 56 && checkedWater < 8; u += 8)
            {
                Vector2 water = ExpandedForestDefinition.ToWorldXZ(new Vector2(u, v));
                if (!curves.IsWater(water, -2)) continue;
                var point = new Vector3(water.x, 0, water.y);
                Require(!navigation.TryFindPath(actor.transform.position, point, path), "Coastal water is blocked");
                checkedWater++;
            }
            Require(checkedWater > 0, "Water check samples exist inside the playable boundary");
            Require(!navigation.TryFindPath(actor.transform.position,
                ExpandedForestDefinition.ToWorld(new Vector2(-80, 0)), path), "Decorative forest is outside walking bounds");
            Require(!navigation.TryFindPath(actor.transform.position, new Vector3(1000, 0, 1000), path),
                "Outside terrain is unreachable");
            Debug.Log("ZHIV EXPANDED FOREST VALIDATION PASSED: 280 m terrain, " + map.Places.Length +
                " places, dry footprints, clear trails, connected arrivals, blocked water/buffer, saved meshes and Canvas. " +
                "Longest arrival search: " + longestSearch.ToString("F1") + " ms; most expanded cells: " + mostCells +
                ". Check rendering, camera gestures and frame time in Play and on the target phone.");
        }

        private static void ValidateAssets(ForestWorldMap map)
        {
            foreach (GameObject root in map.gameObject.scene.GetRootGameObjects())
            foreach (Transform child in root.GetComponentsInChildren<Transform>(true))
            {
                Require(GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(child.gameObject) == 0,
                    "No missing scripts on " + child.name);
                var filter = child.GetComponent<MeshFilter>();
                if (filter != null) Require(filter.sharedMesh != null && EditorUtility.IsPersistent(filter.sharedMesh),
                    "Saved visible mesh on " + child.name);
                var collider = child.GetComponent<MeshCollider>();
                if (collider != null) Require(collider.sharedMesh != null && EditorUtility.IsPersistent(collider.sharedMesh),
                    "Saved collision mesh on " + child.name);
                var renderer = child.GetComponent<Renderer>();
                if (renderer == null) continue;
                foreach (Material material in renderer.sharedMaterials)
                    Require(material != null && material.shader != null && EditorUtility.IsPersistent(material),
                        "Saved material on " + child.name);
            }
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("ZHIV EXPANDED FOREST VALIDATION FAILED: " + message);
        }
    }
}
