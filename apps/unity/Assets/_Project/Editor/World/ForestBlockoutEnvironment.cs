using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using Zhiv.WorldPrototype;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>
    /// Explicit composition blockout: saved forest contours and sparse editable edge accents.
    /// The recipe paints the masses; this builder does not populate their interiors with trees.
    /// </summary>
    [InitializeOnLoad]
    public static class ForestBlockoutEnvironment
    {
        public const int TreeLimit = 96;
        private const int ObstacleLayer = 9;
        private const float EdgeSampleSpacing = 12f;
        private const float MinimumTreeSpacing = 6f;
        private const float ContourSampleSpacing = .75f;
        private const string ContourRootName = "Forest masses — editable contours";
        private const string GeometryRootName = "Current contour geometry";
        private const string GuideName = "Contour guide — follows saved Terrain";
        private const string BlockersName = "Forest interior — invisible navigation volumes";

        static ForestBlockoutEnvironment()
        {
            Undo.undoRedoPerformed += RebuildOpenNavigation;
        }

        public static ExpandedForestEnvironmentResult Build(Terrain terrain, GroundRecipe recipe,
            PrototypeArtSet art, Transform parent, string assetFolder)
        {
            if (terrain == null || terrain.terrainData == null || recipe == null || art == null ||
                art.Tree == null || art.Water == null)
                throw new ArgumentException("A baked Terrain, recipe and saved tree/water art are required.");
            if (!AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for the contour assets first.", nameof(assetFolder));
            if (recipe.ForestRegions == null || recipe.ForestRegions.Count == 0)
                throw new ArgumentException("A forest blockout needs explicit forest contours.", nameof(recipe));

            var result = new ExpandedForestEnvironmentResult { Root = Group("Forest contours and coast", parent) };
            Transform contours = Group(ContourRootName, result.Root);
            Material outlineMaterial = CreateOutlineMaterial(assetFolder);
            var paths = new GroundPathMath(recipe);
            var random = new System.Random(recipe.Seed + 1971);
            var candidatesByRegion = new List<List<TreeCandidate>>();
            int regionIndex = 0;

            foreach (GroundForestRegion region in recipe.ForestRegions)
            {
                List<Vector2> polygon = ExpandedForestEnvironment.CleanPolygon(region.Points);
                string id = (++regionIndex).ToString("00");
                Transform regionRoot = Group(id + " · " + region.Name, contours);
                Vector2 center = MeanPoint(polygon);
                regionRoot.position = GroundPoint(terrain, center);
                CreateOutline(terrain, polygon, outlineMaterial, regionRoot);
                CreateObstacles(terrain, polygon, regionRoot, assetFolder, id);
                Transform accents = Group("Sparse edge accents — tree prefabs", regionRoot);
                List<TreeCandidate> candidates = EdgeCandidates(polygon, accents, random);
                Shuffle(candidates, random);
                candidatesByRegion.Add(candidates);
            }

            // Round-robin gives every forest mass an opportunity before the total cap is reached.
            // Placement remains deliberately uneven; there is no grid or deep-wood fill.
            var placedPoints = new List<Vector2>();
            int longest = 0;
            foreach (List<TreeCandidate> candidates in candidatesByRegion)
                longest = Mathf.Max(longest, candidates.Count);
            for (int index = 0; index < longest && result.TreeCount < TreeLimit; index++)
            foreach (List<TreeCandidate> candidates in candidatesByRegion)
            {
                if (index >= candidates.Count || result.TreeCount >= TreeLimit) continue;
                TreeCandidate candidate = candidates[index];
                if (!CanPlace(candidate, terrain, recipe, paths, placedPoints)) continue;
                GameObject tree = (GameObject)PrefabUtility.InstantiatePrefab(art.Tree, candidate.Parent);
                tree.name = "Contour tree " + (++result.TreeCount).ToString("000");
                tree.transform.SetPositionAndRotation(GroundPoint(terrain, candidate.Point), candidate.Rotation);
                tree.transform.localScale = candidate.Scale;
                PrefabUtility.RecordPrefabInstancePropertyModifications(tree.transform);
                PrefabUtility.RecordPrefabInstancePropertyModifications(tree);
                placedPoints.Add(candidate.Point);
            }
            result.EditableTreeCount = result.TreeCount;
            result.ForestPatchCount = 0;
            ExpandedForestEnvironment.CreateCoast(terrain, recipe, art.Water, result, assetFolder);
            AssetDatabase.SaveAssets();
            return result;
        }

        public static bool CanRebuildContours(GroundAuthoring authoring)
        {
            return FindBlockoutMap(authoring) != null;
        }

        [MenuItem("Zhiv/Rebuild Forest Contours", priority = 12)]
        private static void RebuildCurrentContours()
        {
            GroundAuthoring ground = Selection.activeGameObject != null
                ? Selection.activeGameObject.GetComponent<GroundAuthoring>() : null;
            if (!CanRebuildContours(ground))
                foreach (ForestWorldMap candidate in Object.FindObjectsByType<ForestWorldMap>(
                    FindObjectsInactive.Include, FindObjectsSortMode.None))
                    if (candidate.IsBlockout && candidate.gameObject.scene == SceneManager.GetActiveScene())
                    {
                        ground = candidate.Ground;
                        break;
                    }
            try { RebuildContours(ground); }
            catch (Exception error) { Debug.LogException(error); }
        }

        /// <summary>Explicitly replaces only generated forest geometry, never paint, relief or tree placements.</summary>
        public static void RebuildContours(GroundAuthoring authoring)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Сначала останови Play Mode.");
            ForestWorldMap map = FindBlockoutMap(authoring);
            if (map == null || authoring.Surface == null || authoring.Surface.terrainData == null || authoring.Recipe == null)
                throw new InvalidOperationException("Открой ForestBlockout и выдели её Ground Surface.");
            GroundRecipe recipe = authoring.Recipe;
            GroundPathMath.ValidateRecipe(recipe);
            if (recipe.ForestRegions == null)
                throw new ArgumentException("Forest Regions не должен быть null; используй пустой список для удаления всех контуров.");
            var sampler = new GroundPathMath(recipe);
            // Validate all new geometry before changing a scene object or creating replacement assets.
            foreach (GroundForestRegion region in recipe.ForestRegions)
                ExpandedForestEnvironment.Triangulate(ExpandedForestEnvironment.CleanPolygon(region.Points));
            ValidateRebuildPlacement(map, sampler);
            Transform contours = FindContourRoot(authoring.gameObject.scene);
            if (contours == null || (contours.lossyScale - Vector3.one).sqrMagnitude > .000001f)
                throw new InvalidOperationException("Не найдена исходная группа контуров или изменён её масштаб. Верни масштаб Forest masses к 1.");
            if (Shader.Find("Universal Render Pipeline/Unlit") == null)
                throw new InvalidOperationException("URP Unlit shader is required for the forest contours.");
            string recipePath = AssetDatabase.GetAssetPath(recipe);
            if (string.IsNullOrEmpty(recipePath) || !recipePath.StartsWith("Assets/", StringComparison.Ordinal))
                throw new InvalidOperationException("Сначала сохрани GroundRecipe как ассет внутри Assets проекта.");
            string updates = Path.GetDirectoryName(recipePath).Replace('\\', '/') + "/ContourUpdates";
            GroundSceneUpgrade.EnsureFolder(updates);
            string folder = AssetDatabase.GenerateUniqueAssetPath(updates + "/Update");
            GroundSceneUpgrade.EnsureFolder(folder);

            Transform staged = Group(GeometryRootName, contours);
            staged.gameObject.SetActive(false);
            staged.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            bool registered = false;
            int undoGroup = -1;
            try
            {
                Material material = CreateOutlineMaterial(folder);
                int index = 0;
                foreach (GroundForestRegion region in recipe.ForestRegions)
                {
                    List<Vector2> polygon = ExpandedForestEnvironment.CleanPolygon(region.Points);
                    string id = (++index).ToString("00");
                    Transform regionRoot = Group(id + " · " + region.Name, staged);
                    regionRoot.position = GroundPoint(authoring.Surface, MeanPoint(polygon));
                    CreateOutline(authoring.Surface, polygon, material, regionRoot);
                    CreateObstacles(authoring.Surface, polygon, regionRoot, folder, id);
                }
                Undo.IncrementCurrentGroup();
                undoGroup = Undo.GetCurrentGroup();
                Undo.SetCurrentGroupName("Rebuild forest contours");
                Undo.RegisterCreatedObjectUndo(staged.gameObject, "Create updated forest contours");
                registered = true;
                RemovePreviousGeometry(contours, staged);
                Undo.RecordObject(staged.gameObject, "Activate updated forest contours");
                staged.gameObject.SetActive(true);
                Undo.RecordObject(map, "Update forest contour count");
                map.ForestRegionCount = recipe.ForestRegions.Count;
                EditorUtility.SetDirty(map);
                RebuildNavigation(authoring.gameObject.scene);
                EditorSceneManager.MarkSceneDirty(authoring.gameObject.scene);
                AssetDatabase.SaveAssets();
                Undo.FlushUndoRecordObjects();
                Undo.CollapseUndoOperations(undoGroup);
                SceneView.RepaintAll();
                Debug.Log("Контуры леса и препятствия обновлены. Деревья, берег и Terrain сохранены. Покраску обновляй отдельно через Bake Layer Paint; сцену сохрани Cmd/Ctrl+S. Новые ассеты: " + folder, authoring);
            }
            catch
            {
                if (registered)
                {
                    Undo.FlushUndoRecordObjects();
                    Undo.RevertAllDownToGroup(undoGroup);
                }
                else if (staged != null) Object.DestroyImmediate(staged.gameObject);
                RebuildNavigation(authoring.gameObject.scene);
                throw;
            }
        }

        private static ForestWorldMap FindBlockoutMap(GroundAuthoring authoring)
        {
            if (authoring == null || !authoring.gameObject.scene.IsValid()) return null;
            foreach (ForestWorldMap map in Object.FindObjectsByType<ForestWorldMap>(
                FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (map.IsBlockout && map.Ground == authoring && map.gameObject.scene == authoring.gameObject.scene)
                    return map;
            return null;
        }

        private static Transform FindContourRoot(Scene scene)
        {
            Transform found = null;
            foreach (GameObject root in scene.GetRootGameObjects())
            foreach (Transform child in root.GetComponentsInChildren<Transform>(true))
            {
                if (child.name != ContourRootName) continue;
                if (found != null) throw new InvalidOperationException("В сцене несколько групп Forest masses; сначала оставь одну исходную группу контуров.");
                found = child;
            }
            return found;
        }

        private static void RemovePreviousGeometry(Transform contours, Transform staged)
        {
            var regions = new HashSet<Transform>();
            var containers = new HashSet<Transform>();
            foreach (Transform node in contours.GetComponentsInChildren<Transform>(true))
            {
                if (node == null || node.IsChildOf(staged)) continue;
                if (node.name == GuideName && node.GetComponent<LineRenderer>() != null)
                {
                    regions.Add(node.parent);
                    Undo.DestroyObjectImmediate(node.GetComponent<LineRenderer>());
                    DeleteEmptyGeneratedNode(node);
                }
                else if (node.name == BlockersName)
                {
                    regions.Add(node.parent);
                    var volumes = new List<Transform>();
                    foreach (Transform volume in node) volumes.Add(volume);
                    foreach (Transform volume in volumes)
                    {
                        MeshCollider collider = volume.GetComponent<MeshCollider>();
                        if (collider == null || collider.sharedMesh == null ||
                            !collider.sharedMesh.name.StartsWith("Convex forest interior ", StringComparison.Ordinal)) continue;
                        Undo.DestroyObjectImmediate(collider);
                        DeleteEmptyGeneratedNode(volume);
                    }
                    DeleteEmptyGeneratedNode(node);
                }
            }
            foreach (Transform region in regions)
            {
                if (region == null) continue;
                if (region.parent != null && region.parent != contours && region.parent.name == GeometryRootName)
                    containers.Add(region.parent);
                if (!DeleteEmptyGeneratedNode(region) && !region.name.StartsWith("Preserved accents · ", StringComparison.Ordinal))
                {
                    Undo.RecordObject(region.gameObject, "Keep manual forest children");
                    region.name = "Preserved accents · " + region.name;
                }
            }
            foreach (Transform container in containers)
            {
                if (container == null) continue;
                if (!DeleteEmptyGeneratedNode(container))
                {
                    Undo.RecordObject(container.gameObject, "Keep manual contour children");
                    container.name = "Preserved contour children";
                }
            }
        }

        private static bool DeleteEmptyGeneratedNode(Transform node)
        {
            if (node == null || node.childCount != 0 || node.GetComponents<Component>().Length != 1) return false;
            Undo.DestroyObjectImmediate(node.gameObject);
            return true;
        }

        private static void ValidateRebuildPlacement(ForestWorldMap map, GroundPathMath sampler)
        {
            GroundRecipe recipe = map.Ground.Recipe;
            for (int trail = 0; trail < recipe.Trails.Count; trail++)
                foreach (Vector2 point in sampler.GetTrailPoints(trail))
                    if (sampler.IsForest(point, recipe.Trails[trail].Width * .5f + recipe.Trails[trail].Feather + .4f))
                        throw new ArgumentException("Контур леса перекрывает тропу «" + recipe.Trails[trail].Name + "» рядом с " + point + ". Отодвинь край леса от тропы.");
            foreach (GroundPad pad in recipe.Pads)
            foreach (GroundForestRegion region in recipe.ForestRegions)
            {
                Vector2 half = pad.Size * .5f + Vector2.one * .4f;
                Vector2 min = pad.Center - half, max = pad.Center + half;
                var corners = new[] { min, new Vector2(min.x, max.y), max, new Vector2(max.x, min.y) };
                foreach (Vector2 corner in corners)
                    if (Contains(region.Points, corner))
                        throw new ArgumentException("Контур леса перекрывает площадку «" + pad.Name + "». Отодвинь его от основания.");
                for (int i = 0; i < region.Points.Count; i++)
                    if (SegmentTouchesRectangle(region.Points[i], region.Points[(i + 1) % region.Points.Count], min, max))
                        throw new ArgumentException("Контур леса пересекает площадку «" + pad.Name + "». Отодвинь его от основания.");
            }
            if (map.Places != null)
                foreach (ForestLandmark place in map.Places)
                    if (place != null && place.Arrival != null && sampler.IsForest(
                        new Vector2(place.Arrival.position.x, place.Arrival.position.z), .4f))
                        throw new ArgumentException("Контур леса перекрывает вход «" + place.DisplayName + "».");
            foreach (WorldActorController actor in Object.FindObjectsByType<WorldActorController>(
                FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (actor.gameObject.scene == map.gameObject.scene && sampler.IsForest(
                    new Vector2(actor.transform.position.x, actor.transform.position.z), .4f))
                    throw new ArgumentException("Контур леса перекрывает позицию героя. Отодвинь контур или перемести героя на открытую землю.");
        }

        private static bool SegmentTouchesRectangle(Vector2 a, Vector2 b, Vector2 min, Vector2 max)
        {
            float entry = 0, exit = 1;
            Vector2 delta = b - a;
            for (int axis = 0; axis < 2; axis++)
            {
                if (Mathf.Abs(delta[axis]) < .000001f)
                {
                    if (a[axis] < min[axis] || a[axis] > max[axis]) return false;
                    continue;
                }
                float first = (min[axis] - a[axis]) / delta[axis];
                float last = (max[axis] - a[axis]) / delta[axis];
                entry = Mathf.Max(entry, Mathf.Min(first, last));
                exit = Mathf.Min(exit, Mathf.Max(first, last));
                if (entry > exit) return false;
            }
            return true;
        }

        private static void RebuildOpenNavigation()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            foreach (ForestWorldMap map in Object.FindObjectsByType<ForestWorldMap>(
                FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (map.IsBlockout) RebuildNavigation(map.gameObject.scene);
        }

        private static void RebuildNavigation(Scene scene)
        {
            foreach (GridNavigator navigator in Object.FindObjectsByType<GridNavigator>(
                FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (navigator.gameObject.scene == scene) navigator.Rebuild();
        }

        private static Material CreateOutlineMaterial(string folder)
        {
            Shader shader = Shader.Find("Universal Render Pipeline/Unlit");
            if (shader == null) throw new InvalidOperationException("URP Unlit shader is required for the forest contours.");
            var material = new Material(shader) { name = "Forest contour guide", enableInstancing = true };
            material.SetColor("_BaseColor", new Color(.28f, .43f, .30f, 1f));
            material.SetFloat("_Cull", (float)CullMode.Off);
            AssetDatabase.CreateAsset(material, AssetDatabase.GenerateUniqueAssetPath(folder + "/ForestContourGuide.mat"));
            return material;
        }

        private static void CreateOutline(Terrain terrain, List<Vector2> polygon, Material material, Transform parent)
        {
            Transform guide = Group(GuideName, parent);
            var positions = new List<Vector3>();
            for (int edge = 0; edge < polygon.Count; edge++)
            {
                Vector2 a = polygon[edge], b = polygon[(edge + 1) % polygon.Count];
                int steps = Mathf.Max(1, Mathf.CeilToInt(Vector2.Distance(a, b) / ContourSampleSpacing));
                for (int step = 0; step < steps; step++)
                {
                    Vector3 point = GroundPoint(terrain, Vector2.Lerp(a, b, step / (float)steps));
                    point.y += .08f;
                    positions.Add(guide.InverseTransformPoint(point));
                }
            }
            var line = guide.gameObject.AddComponent<LineRenderer>();
            line.sharedMaterial = material;
            line.useWorldSpace = false;
            line.loop = true;
            line.widthMultiplier = .14f;
            line.numCornerVertices = 2;
            line.shadowCastingMode = ShadowCastingMode.Off;
            line.receiveShadows = false;
            line.positionCount = positions.Count;
            line.SetPositions(positions.ToArray());
        }

        private static void CreateObstacles(Terrain terrain, List<Vector2> polygon, Transform parent,
            string folder, string regionId)
        {
            Transform blockers = Group(BlockersName, parent);
            List<int> triangles = ExpandedForestEnvironment.Triangulate(polygon);
            float bottom = terrain.transform.position.y - .25f;
            float top = terrain.transform.position.y + terrain.terrainData.size.y + 2f;
            for (int i = 0; i < triangles.Count; i += 3)
            {
                Vector2 a = polygon[triangles[i]], b = polygon[triangles[i + 1]], c = polygon[triangles[i + 2]];
                Vector2 center = (a + b + c) / 3f;
                string id = regionId + "-" + (i / 3 + 1).ToString("000");
                Transform obstacle = Group("Forest volume " + id, blockers);
                obstacle.position = new Vector3(center.x, 0, center.y);
                obstacle.gameObject.layer = ObstacleLayer;
                Mesh volume = ExpandedForestEnvironment.TrianglePrism(a - center, b - center, c - center, bottom, top);
                volume.name = "Convex forest interior " + id;
                ExpandedForestEnvironment.SaveMesh(volume, folder, "ForestVolume" + id);
                var collider = obstacle.gameObject.AddComponent<MeshCollider>();
                collider.sharedMesh = volume;
                collider.convex = true;
            }
        }

        private static List<TreeCandidate> EdgeCandidates(List<Vector2> polygon, Transform parent, System.Random random)
        {
            var result = new List<TreeCandidate>();
            float perimeter = 0f;
            for (int i = 0; i < polygon.Count; i++)
                perimeter += Vector2.Distance(polygon[i], polygon[(i + 1) % polygon.Count]);
            int count = Mathf.Max(1, Mathf.CeilToInt(perimeter / EdgeSampleSpacing));
            float spacing = perimeter / count;
            float phase = Next(random, .1f, .9f) * spacing;
            int edge = 0;
            float edgeStart = 0f;
            float edgeLength = Vector2.Distance(polygon[0], polygon[1]);
            for (int sample = 0; sample < count; sample++)
            {
                float distance = Mathf.Clamp(phase + sample * spacing + Next(random, -1.4f, 1.4f), 0, perimeter - .001f);
                while (edge < polygon.Count - 1 && distance > edgeStart + edgeLength)
                {
                    edgeStart += edgeLength;
                    edge++;
                    edgeLength = Vector2.Distance(polygon[edge], polygon[(edge + 1) % polygon.Count]);
                }
                Vector2 a = polygon[edge], b = polygon[(edge + 1) % polygon.Count];
                Vector2 direction = (b - a) / edgeLength;
                // CleanPolygon returns CCW vertices; the left normal points into this forest mass.
                Vector2 inward = new Vector2(-direction.y, direction.x);
                Vector2 point = a + direction * (distance - edgeStart) + inward * Next(random, 2.4f, 4.2f);
                if (!Contains(polygon, point)) continue;
                float scale = Next(random, 1.1f, 1.36f);
                result.Add(new TreeCandidate
                {
                    Point = point, Parent = parent, CrownRadius = scale * 1.4f,
                    Rotation = Quaternion.Euler(0, Next(random, 0, 360), 0),
                    Scale = new Vector3(scale * Next(random, .92f, 1.08f), scale * Next(random, .92f, 1.08f), scale)
                });
            }
            return result;
        }

        private static bool CanPlace(TreeCandidate candidate, Terrain terrain, GroundRecipe recipe,
            GroundPathMath paths, List<Vector2> placed)
        {
            Vector2 point = candidate.Point;
            Vector2 map = ExpandedForestDefinition.ToMapXZ(point);
            Rect bounds = ExpandedForestDefinition.PlayableMapBounds;
            const float backdrop = 12f;
            if (map.x < bounds.xMin - backdrop || map.x > bounds.xMax + backdrop ||
                map.y < bounds.yMin - backdrop || map.y > bounds.yMax + backdrop ||
                !paths.IsForest(point, -1f) || paths.IsWater(point, candidate.CrownRadius + 1.2f)) return false;
            foreach (Vector2 previous in placed)
                if ((point - previous).sqrMagnitude < MinimumTreeSpacing * MinimumTreeSpacing) return false;
            float radius = candidate.CrownRadius + .65f;
            Vector2 projectedCrown = point + ExpandedForestDefinition.ToWorldXZ(new Vector2(0, 5.8f));
            if (TouchesTrail(paths, point, radius) || TouchesTrail(paths, projectedCrown, radius) ||
                TouchesPad(recipe, point, radius) || TouchesPad(recipe, projectedCrown, radius)) return false;
            return GroundPoint(terrain, point).y > ExpandedForestDefinition.WaterHeight + .15f;
        }

        private static bool TouchesPad(GroundRecipe recipe, Vector2 point, float radius)
        {
            foreach (GroundPad pad in recipe.Pads)
            {
                float dx = Mathf.Max(0f, Mathf.Abs(point.x - pad.Center.x) - pad.Size.x * .5f);
                float dz = Mathf.Max(0f, Mathf.Abs(point.y - pad.Center.y) - pad.Size.y * .5f);
                float clearance = radius + pad.Feather + .5f;
                if (dx * dx + dz * dz < clearance * clearance) return true;
            }
            return false;
        }

        private static bool TouchesTrail(GroundPathMath paths, Vector2 point, float radius)
        {
            if (paths.SamplePathWeight(point) > .01f) return true;
            for (int i = 0; i < 16; i++)
            {
                float angle = i * Mathf.PI * 2f / 16f;
                if (paths.SamplePathWeight(point + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius) > .01f)
                    return true;
            }
            return false;
        }

        private static bool Contains(List<Vector2> polygon, Vector2 point)
        {
            bool inside = false;
            for (int i = 0, j = polygon.Count - 1; i < polygon.Count; j = i++)
                if ((polygon[i].y > point.y) != (polygon[j].y > point.y) &&
                    point.x < (polygon[j].x - polygon[i].x) * (point.y - polygon[i].y) /
                    (polygon[j].y - polygon[i].y) + polygon[i].x) inside = !inside;
            return inside;
        }

        private static Vector2 MeanPoint(List<Vector2> polygon)
        {
            Vector2 sum = Vector2.zero;
            foreach (Vector2 point in polygon) sum += point;
            return sum / polygon.Count;
        }

        private static Vector3 GroundPoint(Terrain terrain, Vector2 point)
        {
            var position = new Vector3(point.x, 0, point.y);
            position.y = terrain.SampleHeight(position) + terrain.transform.position.y;
            return position;
        }

        private static Transform Group(string name, Transform parent)
        {
            Transform group = new GameObject(name).transform;
            if (parent != null && group.gameObject.scene != parent.gameObject.scene)
                SceneManager.MoveGameObjectToScene(group.gameObject, parent.gameObject.scene);
            group.SetParent(parent, false);
            return group;
        }

        private static void Shuffle<T>(List<T> values, System.Random random)
        {
            for (int i = values.Count - 1; i > 0; i--)
            {
                int j = random.Next(i + 1);
                T value = values[i]; values[i] = values[j]; values[j] = value;
            }
        }

        private static float Next(System.Random random, float min, float max) =>
            min + (float)random.NextDouble() * (max - min);

        private sealed class TreeCandidate
        {
            public Vector2 Point;
            public Transform Parent;
            public float CrownRadius;
            public Quaternion Rotation;
            public Vector3 Scale;
        }
    }
}
